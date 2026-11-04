// Processing stage: data cleanup and validation (RUBRIC section 7).
// Hard stops abort the run (status FAILED, no recommendations). Soft fixes are applied and logged.
import { addDays, diffDays, fromMs, isoWeekLabel, lastCompleteWeekStart, parseIsoWeek, toMs, validDate } from "./dates";
import type { RulesParams, SchemaMap } from "./config";
import type { RawData } from "./ingest";

export type Issue = { severity: "HARD_STOP" | "SOFT_FIX" | "FALLBACK" | "INFO"; code: string; count: number; detail: string; sku_id?: string | null };

export type SkuRow = {
  sku_id: string; sku_name: string; category: string; distributor_id: string; perishable: boolean;
  standard_qty: number | null; stock: number | null; on_order: number | null; unit_price: number | null; filled_weeks: number;
};

/** Distributor-level weekly units, column-oriented so 1.8M rows stay cheap. weekIdx indexes PlanningData.weekStarts. */
export type DistTable = { sku: string[]; dist: string[]; weekIdx: Int32Array; units: Float64Array; length: number };

export type PlanningData = {
  sku: SkuRow[];
  weekStarts: string[];                 // continuous Mondays, oldest first, ending at lastWeekStart
  series: Map<string, Float64Array>;    // sku -> weekly units, NaN before the SKU's first sale week
  festivalActive: boolean;
  asOf: string;
  lastWeekStart: string;
  distWeekly: DistTable | null;
  filledWeeks: Record<string, number>;
};

export type CleanResult = { issues: Issue[]; data: PlanningData | null; fallbacks: string[]; metrics: Record<string, unknown> };
export const hardStops = (r: { issues: Issue[] }) => r.issues.filter((i) => i.severity === "HARD_STOP");

const ID_RE = /^([A-Za-z]+)[-_ ]?(\d+)$/;

function idWidth(ids: Iterable<string>): number {
  let w = 0;
  for (const s of new Set(ids)) { const m = ID_RE.exec(s.trim()); if (m) w = Math.max(w, m[2].length); }
  return w || 3;
}

/** Trim, upper-case, zero-pad the numeric part (sku-1 -> SKU001). Cached per distinct raw value. */
function normaliser(width: number) {
  const cache = new Map<string, string>();
  return (raw: string) => {
    let v = cache.get(raw);
    if (v === undefined) {
      const s = raw.trim().toUpperCase();
      const m = ID_RE.exec(s);
      v = m ? m[1] + String(Number(m[2])).padStart(width, "0") : s;
      cache.set(raw, v);
    }
    return v;
  };
}

const truthy = (s: string) => ["TRUE", "1", "YES", "Y"].includes(s.trim().toUpperCase());
const num = (s: string) => { const t = s.trim(); if (t === "") return NaN; const n = Number(t); return Number.isFinite(n) ? n : NaN; };

export function clean(raw: RawData, p: RulesParams, schema: SchemaMap, asOfIn?: string | null): CleanResult {
  const issues: Issue[] = [];
  const fallbacks: string[] = [];
  const metrics: Record<string, unknown> = {};
  const hard = (code: string, detail: string, count = 0) => issues.push({ severity: "HARD_STOP", code, count, detail });
  const soft = (code: string, count: number, detail: string, sku_id?: string) => issues.push({ severity: "SOFT_FIX", code, count, detail, sku_id });
  const info = (code: string, count: number, detail: string) => issues.push({ severity: "INFO", code, count, detail });
  const fallback = (code: string, detail: string, count = 0) => { fallbacks.push(code); issues.push({ severity: "FALLBACK", code, count, detail }); };
  const fail = (): CleanResult => ({ issues, data: null, fallbacks, metrics });

  const skuT = raw.sku_master.columns;
  const salesT = raw.weekly_sales.columns;
  const invT = raw.current_inventory.columns;
  const calT = raw.calendar.columns;
  const nSkuRows = raw.sku_master.length;
  const nSales = raw.weekly_sales.length;
  const nInv = raw.current_inventory.length;

  // ---- IDs -------------------------------------------------------------------------------
  const skuNorm = normaliser(idWidth(skuT.sku_id));
  const distNorm = normaliser(idWidth(raw.distributor_master.columns.distributor_id));
  let changed = 0;
  const skuIds = skuT.sku_id.map(skuNorm);
  const skuDist = skuT.distributor_id.map(distNorm);
  const sSku = new Array<string>(nSales);
  for (let i = 0; i < nSales; i++) { const raw0 = salesT.sku_id[i]; sSku[i] = skuNorm(raw0); if (sSku[i] !== raw0) changed++; }
  const iSku = invT.sku_id.map((s) => { const n = skuNorm(s); if (n !== s) changed++; return n; });
  skuT.sku_id.forEach((s, i) => { if (skuIds[i] !== s) changed++; });
  const hasDist = "distributor_id" in salesT;
  let sDist: string[] = [];
  if (hasDist) {
    sDist = new Array(nSales);
    for (let i = 0; i < nSales; i++) { const r0 = salesT.distributor_id[i]; sDist[i] = distNorm(r0); if (sDist[i] !== r0) changed++; }
  }
  if (changed) soft("IDS_NORMALISED", changed, "Trimmed / upper-cased / zero-padded IDs");

  // ---- SKU master (last duplicate wins) ----------------------------------------------------
  const masterIdx = new Map<string, number>();
  skuIds.forEach((s, i) => masterIdx.set(s, i));
  if (masterIdx.size < nSkuRows) soft("DUPLICATE_SKU_MASTER", nSkuRows - masterIdx.size, "Duplicate SKU rows in master: kept last");
  if (masterIdx.size === 0) { hard("NO_ACTIVE_SKUS", "SKU master is empty"); return fail(); }
  const active = [...masterIdx.keys()].sort();
  const skuPos = new Map(active.map((s, i) => [s, i] as const));
  const S = active.length;

  // ---- weeks, units ------------------------------------------------------------------------
  const weekCache = new Map<string, number>(); // label -> ms of Monday
  const weekMs = new Array<number>(nSales);
  try {
    for (let i = 0; i < nSales; i++) {
      const lab = salesT.week[i];
      let v = weekCache.get(lab);
      if (v === undefined) { v = toMs(parseIsoWeek(lab)); weekCache.set(lab, v); }
      weekMs[i] = v;
    }
  } catch (e) {
    hard("BAD_WEEK_FORMAT", `Week column is not ISO like 2026-W27: ${(e as Error).message}`);
    return fail();
  }
  const units = new Float64Array(nSales);
  let badUnits = 0;
  for (let i = 0; i < nSales; i++) { units[i] = num(salesT.units_sold[i]); if (Number.isNaN(units[i])) badUnits++; }
  if (badUnits) soft("NON_NUMERIC_UNITS", badUnits, "Rows with non-numeric Units_Sold dropped");

  // ---- inventory as-of date; freshness works against it, not the wall clock ----------------
  const invDates = invT.as_of_date.map((d) => d.trim()).filter(validDate);
  if (!invDates.length) { hard("BAD_INVENTORY_DATE", "Inventory As_Of_Date could not be parsed"); return fail(); }
  const invDate = invDates.reduce((a, b) => (a > b ? a : b));
  let asOf = asOfIn ?? null;
  if (!asOf) {
    asOf = invDate;
    info("AS_OF_DEFAULT", 0, `As-of date defaulted to the inventory As_Of_Date ${asOf}`);
  }
  const lastWk = lastCompleteWeekStart(asOf);
  const lastWkMs = toMs(lastWk);

  // ---- keep rows: numeric, known SKU, not after the last complete week; dedupe keep last ----
  let unknownRows = 0, lateRows = 0;
  const unknownNames = new Set<string>();
  const dIdx = new Map<string, number>();
  const keep: number[] = [];
  const seen = new Map<number, number>();    // composite key -> position in `keep`
  let dupRows = 0;
  let nDist = 0;
  for (let i = 0; i < nSales; i++) {
    if (Number.isNaN(units[i])) continue;
    const sp = skuPos.get(sSku[i]);
    if (sp === undefined) { unknownRows++; if (unknownNames.size < 10) unknownNames.add(sSku[i]); continue; }
    if (weekMs[i] > lastWkMs) { lateRows++; continue; }
    let dp = 0;
    if (hasDist) { dp = dIdx.get(sDist[i]) ?? -1; if (dp < 0) { dp = nDist++; dIdx.set(sDist[i], dp); } }
    // composite key: SKU, distributor, absolute week number (ms / 7 days is unique per Monday)
    const wk = Math.round(weekMs[i] / 604_800_000);
    const k2 = (sp * (1 << 20) + dp) * 100_000 + wk;
    const prev = seen.get(k2);
    if (prev !== undefined) { keep[prev] = i; dupRows++; } else { seen.set(k2, keep.length); keep.push(i); }
  }
  if (unknownRows) soft("UNKNOWN_SKU_SALES_QUARANTINED", unknownRows, `Sales rows for SKUs not in master: ${JSON.stringify([...unknownNames].sort())}`);
  if (dupRows) soft("DUPLICATE_SALES_ROWS", dupRows, `Duplicate (week, sku${hasDist ? ", distributor" : ""}) rows: kept last`);
  if (lateRows) info("SALES_AFTER_LAST_COMPLETE_WEEK", lateRows, `Rows after the last complete week (${lastWk}) excluded`);
  if (!keep.length) { hard("NO_SALES", "No sales rows left at or before the last complete week"); return fail(); }

  // ---- freshness gate ------------------------------------------------------------------------
  let maxWeekMs = -Infinity, minWeekMs = Infinity;
  for (const i of keep) { if (weekMs[i] > maxWeekMs) maxWeekMs = weekMs[i]; if (weekMs[i] < minWeekMs) minWeekMs = weekMs[i]; }
  const latestWkEnd = addDays(fromMs(maxWeekMs), 6);
  const salesAge = diffDays(asOf, latestWkEnd);
  const invAge = diffDays(asOf, invDate);
  Object.assign(metrics, { sales_age_days: salesAge, inventory_age_days: invAge, as_of: asOf, last_week: isoWeekLabel(lastWk) });
  if (salesAge > p.max_data_age_days) hard("STALE_SALES", `Latest sales week ends ${latestWkEnd}, ${salesAge} days before as-of ${asOf} (max ${p.max_data_age_days})`, salesAge);
  if (invAge > p.max_data_age_days) hard("STALE_INVENTORY", `Inventory As_Of_Date ${invDate} is ${invAge} days before as-of ${asOf} (max ${p.max_data_age_days})`, invAge);
  if (invAge < 0) info("INVENTORY_NEWER_THAN_AS_OF", -invAge, `Inventory snapshot (${invDate}) is newer than the as-of date: replay mode, current stock vs older sales`);

  // ---- inventory ---------------------------------------------------------------------------------
  const hasOO = "on_order_units" in invT;
  const invKeep = new Map<string, number>(); // sku|location -> row (last wins)
  let unkInv = 0, dupInv = 0;
  for (let i = 0; i < nInv; i++) {
    if (!skuPos.has(iSku[i])) { unkInv++; continue; }
    const k = iSku[i] + "|" + invT.location[i];
    if (invKeep.has(k)) dupInv++;
    invKeep.set(k, i);
  }
  if (unkInv) soft("UNKNOWN_SKU_INVENTORY_QUARANTINED", unkInv, "Inventory rows for SKUs not in master");
  if (dupInv) soft("DUPLICATE_INVENTORY_ROWS", dupInv, "Duplicate (sku, location) rows: kept last");
  const stock = new Map<string, number>();
  const onOrder = new Map<string, number>();
  let multi = 0;
  for (const i of invKeep.values()) {
    const s = iSku[i];
    const v = num(invT.units_on_hand[i]);
    if (stock.has(s)) multi++;
    if (!Number.isNaN(v)) stock.set(s, (stock.get(s) ?? 0) + v);
    if (hasOO) { const o = num(invT.on_order_units[i]); onOrder.set(s, (onOrder.get(s) ?? 0) + (Number.isNaN(o) ? 0 : o)); }
  }
  if (multi) info("MULTI_LOCATION_STOCK", multi, "Stock summed across locations");
  const missingInv = active.filter((s) => !stock.has(s));
  const pctMissing = (100 * missingInv.length) / Math.max(S, 1);
  metrics.pct_skus_missing_inventory = Math.round(pctMissing * 100) / 100;
  if (missingInv.length) soft("MISSING_INVENTORY_ROW", missingInv.length, `Active SKUs without inventory: ${JSON.stringify(missingInv.slice(0, 10))}`);
  if (pctMissing > p.max_missing_inventory_pct) hard("TOO_MANY_SKUS_WITHOUT_INVENTORY", `${pctMissing.toFixed(1)}% of active SKUs have no inventory row (max ${p.max_missing_inventory_pct}%)`, missingInv.length);
  const negStock = [...stock].filter(([, v]) => v < 0).map(([k]) => k);
  if (negStock.length) soft("NEGATIVE_STOCK", negStock.length, `Negative Units_On_Hand: ${JSON.stringify(negStock.slice(0, 10))} (SKU sent to exceptions)`);
  if (hardStops({ issues }).length) return fail();

  // ---- weekly demand per SKU: net returns, floor at 0, fill gaps ------------------------------
  const W = Math.round((lastWkMs - minWeekMs) / 604_800_000) + 1;
  const weekStarts = Array.from({ length: W }, (_, k) => fromMs(minWeekMs + k * 604_800_000));
  const mat = new Float64Array(S * W).fill(NaN);
  let negRows = 0;
  const dist: DistTable | null = hasDist ? { sku: [], dist: [], weekIdx: new Int32Array(keep.length), units: new Float64Array(keep.length), length: keep.length } : null;
  keep.forEach((i, n) => {
    const sp = skuPos.get(sSku[i])!;
    const wi = Math.round((weekMs[i] - minWeekMs) / 604_800_000);
    if (units[i] < 0) negRows++;
    const idx = sp * W + wi;
    mat[idx] = Number.isNaN(mat[idx]) ? units[i] : mat[idx] + units[i];
    if (dist) { dist.sku.push(sSku[i]); dist.dist.push(sDist[i]); dist.weekIdx[n] = wi; dist.units[n] = units[i]; }
  });
  let floored = 0;
  for (let k = 0; k < mat.length; k++) if (mat[k] < 0) { mat[k] = 0; floored++; }
  if (negRows) soft("NEGATIVE_UNITS_NETTED", negRows, `Negative Units_Sold treated as returns, netted per SKU-week; ${floored} SKU-weeks floored at 0`);
  const series = new Map<string, Float64Array>();
  const filledWeeks: Record<string, number> = {};
  let filledTotal = 0;
  active.forEach((s, sp) => {
    const row = mat.subarray(sp * W, (sp + 1) * W);
    let started = false, filled = 0;
    for (let w = 0; w < W; w++) {
      if (!Number.isNaN(row[w])) started = true;
      else if (started) { row[w] = 0; filled++; }
    }
    if (filled) { filledWeeks[s] = filled; filledTotal += filled; }
    series.set(s, row);
  });
  const nFilledSkus = Object.keys(filledWeeks).length;
  if (nFilledSkus) soft("MISSING_WEEKS_FILLED", filledTotal, `${nFilledSkus} SKU(s) had missing weeks filled with 0`);
  if (nFilledSkus <= 50) for (const [s, n] of Object.entries(filledWeeks)) if (n > p.max_filled_weeks) soft("SKU_MANY_WEEKS_FILLED", n, `${n} weeks filled with 0 (> ${p.max_filled_weeks}): flagged`, s);

  if (!hasDist) fallback("NO_DISTRIBUTOR_IN_SALES", "Sales file has no Distributor_ID column: DISTRIBUTOR_ANOMALY is switched off");

  // ---- SKU table --------------------------------------------------------------------------------
  const pv = schema.perishability_values;
  const hasPrice = "unit_price" in skuT;
  let noQty = 0;
  const sku: SkuRow[] = active.map((s) => {
    const m = masterIdx.get(s)!;
    const q = num(skuT.standard_order_qty[m]);
    if (Number.isNaN(q)) noQty++;
    const price = hasPrice ? num(skuT.unit_price[m]) : NaN;
    return {
      sku_id: s, sku_name: skuT.sku_name[m], category: skuT.category[m], distributor_id: skuDist[m],
      perishable: skuT.perishability[m].trim().toLowerCase() === String(pv.perishable).toLowerCase(),
      standard_qty: Number.isNaN(q) ? null : q,
      stock: stock.has(s) ? stock.get(s)! : null,
      on_order: hasOO ? onOrder.get(s) ?? 0 : null,
      unit_price: Number.isNaN(price) ? null : price,
      filled_weeks: filledWeeks[s] ?? 0,
    };
  });
  if (noQty) fallback("STANDARD_QTY_MISSING", `${noQty} SKU(s) lack a standard reorder qty: target-cover formula used`, noQty);
  if (!hasPrice) fallback("NO_UNIT_PRICE", "No unit price in the data: ranking and value-at-risk are in units, not rupees");
  if (!("lead_time_days" in skuT)) fallback("NO_LEAD_TIME", "No lead time in the data: not used by any rule");
  if (!hasOO) fallback("NO_ON_ORDER_UNITS", "No on-order / open-PO units: cover uses on-hand stock only");
  fallback("STOCK_AT_SKU_LEVEL", "Stock is one figure per SKU (not per distributor)");

  // ---- festival flag ---------------------------------------------------------------------------------
  const [ay, am] = asOf.split("-").map(Number);
  let festival: boolean | null = null;
  for (let i = 0; i < raw.calendar.length; i++) if (Number(calT.year[i]) === ay && Number(calT.month[i]) === am) festival = truthy(calT.is_festival_month[i]);
  if (festival === null) {
    festival = p.festival_months.includes(am);
    fallback("FESTIVAL_FROM_CONFIG", `As-of month ${am} not in calendar file: used festival_months from rules config`);
  }
  metrics.festival_active = festival;

  return { issues, fallbacks, metrics, data: { sku, weekStarts, series, festivalActive: festival, asOf, lastWeekStart: lastWk, distWeekly: dist, filledWeeks } };
}
