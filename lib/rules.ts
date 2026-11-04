// Context stage: Raghav's rules as a pure, deterministic engine.
// No network, no LLM, no I/O. Driven entirely by RulesParams. Strict inequalities exactly as RUBRIC section 4 words them.
import type { RulesParams } from "./config";
import type { DistTable, PlanningData } from "./cleanup";

/** Round to 9 decimals so float noise cannot flip a strict boundary (cover exactly 6.0, +20.0%). */
const r9 = (x: number) => Math.round(x * 1e9) / 1e9;
const fin = (x: number): number | null => (Number.isFinite(x) ? x : null);

export type Action = "REORDER_NOW" | "REORDER_HIGH_DEMAND" | "PAUSE_ORDER" | "PAUSE_REVIEW" | "NO_ACTION" | "EXCEPTION";
export const REORDER_ACTIONS: Action[] = ["REORDER_NOW", "REORDER_HIGH_DEMAND"];
const PRIORITY_ORDER: Record<string, number> = { P1: 1, P2: 2, P3: 3, EX: 4, "": 5 };

export type Reason = { rule: string; code: string } & Record<string, unknown>;
export type Rec = {
  rank: number; sku_id: string; sku_name: string; category: string; perishable: boolean; distributor_id: string;
  stock: number | null; standard_qty: number | null; history_weeks: number;
  baseline_avg_weekly: number | null; recent_avg_weekly: number | null; effective_avg_weekly: number | null;
  festival_active: boolean; cover_weeks: number | null; cover_weeks_without_on_order: number | null; recent_vs_baseline_pct: number | null;
  flags: string[]; action: Action; qty_multiplier: number | null; base_qty: number | null; recommended_qty: number; qty_capped: boolean;
  priority: "P1" | "P2" | "P3" | "EX" | ""; value_at_risk: number; value_unit: "units" | "INR";
  exception_codes: string[]; review_before_approving: boolean; reasons: Reason[]; fallbacks: string[];
};
export type Exc = { sku_id: string; code: string; blocking: boolean; detail: string };
export type RulesResult = { recs: Rec[]; exceptions: Exc[]; runFallbacks: string[] };

function nanmean(a: Float64Array, from: number): number {
  let s = 0, n = 0;
  for (let i = Math.max(0, from); i < a.length; i++) if (!Number.isNaN(a[i])) { s += a[i]; n++; }
  return n ? s / n : NaN;
}

export type Anomaly = { sku_id: string; distributor_id: string; latest: number; trailing_mean: number; z: number; drop_pct: number };

/** SKU x distributor anomalies: |z| > threshold vs the distributor's own trailing average, or a drop > 40%. */
export function distributorAnomalies(d: DistTable, nWeeks: number, p: RulesParams): Anomaly[] {
  const nPrior = p.baseline_window_weeks;
  const first = nWeeks - 1 - nPrior;               // oldest week index in the window
  const pairIdx = new Map<string, number>();
  const pairs: [string, string][] = [];
  for (let i = 0; i < d.length; i++) {
    if (d.weekIdx[i] < first) continue;
    const k = d.sku[i] + "|" + d.dist[i];
    if (!pairIdx.has(k)) { pairIdx.set(k, pairs.length); pairs.push([d.sku[i], d.dist[i]]); }
  }
  const cols = nPrior + 1;
  const M = new Float64Array(pairs.length * cols).fill(NaN);
  for (let i = 0; i < d.length; i++) {
    if (d.weekIdx[i] < first) continue;
    M[pairIdx.get(d.sku[i] + "|" + d.dist[i])! * cols + (d.weekIdx[i] - first)] = Math.max(d.units[i], 0);
  }
  const out: Anomaly[] = [];
  for (let k = 0; k < pairs.length; k++) {
    let n = 0, sum = 0;
    for (let c = 0; c < nPrior; c++) { const v = M[k * cols + c]; if (!Number.isNaN(v)) { n++; sum += v; } }
    if (n < p.distributor_anomaly_min_history_weeks) continue;
    const mean = sum / n;
    if (mean < p.distributor_anomaly_min_avg_units) continue;
    let ss = 0;
    for (let c = 0; c < nPrior; c++) { const v = M[k * cols + c]; if (!Number.isNaN(v)) ss += (v - mean) ** 2; }
    const std = n > 1 ? Math.sqrt(ss / (n - 1)) : NaN;
    const lastV = M[k * cols + nPrior];
    const latest = Number.isNaN(lastV) ? 0 : lastV;      // a distributor that stopped buying counts as 0
    const z = std > 0 ? (latest - mean) / std : 0;
    const drop = mean > 0 ? ((mean - latest) / mean) * 100 : 0;
    if (Math.abs(r9(z)) > p.distributor_anomaly_z || r9(drop) > p.distributor_anomaly_drop_pct) {
      out.push({ sku_id: pairs[k][0], distributor_id: pairs[k][1], latest, trailing_mean: mean, z, drop_pct: drop });
    }
  }
  return out;
}

export function evaluate(data: PlanningData, p: RulesParams): RulesResult {
  const uplift = p.festival_uplift_pct / 100;
  const festival = data.festivalActive;
  const exc: Exc[] = [];
  const recs: Rec[] = [];
  const runFallbacks: string[] = [];
  const W = data.weekStarts.length;

  const anomaliesBySku = new Map<string, Anomaly[]>();
  if (data.distWeekly) {
    for (const a of distributorAnomalies(data.distWeekly, W, p)) {
      if (!anomaliesBySku.has(a.sku_id)) anomaliesBySku.set(a.sku_id, []);
      anomaliesBySku.get(a.sku_id)!.push(a);
    }
  } else runFallbacks.push("DISTRIBUTOR_ANOMALY_DISABLED_NO_DISTRIBUTOR_COLUMN");

  for (const s of data.sku) {
    const series = data.series.get(s.sku_id) ?? new Float64Array(W).fill(NaN);
    let history = 0;
    for (let i = 0; i < series.length; i++) if (!Number.isNaN(series[i])) history++;
    const baseline = nanmean(series, W - p.baseline_window_weeks);
    const recent = nanmean(series, W - p.recent_window_weeks);
    const effective = festival ? baseline * (1 + uplift) : baseline;
    const r1Base = p.festival_uplift_applies_to_r1_baseline ? effective : baseline;

    const stock = s.stock;
    const stockWith = (stock ?? NaN) + (s.on_order ?? 0);
    const perish = s.perishable;
    const pos = effective > 0;
    const cover = pos ? r9(stockWith / effective) : NaN;
    const coverWo = pos && stock !== null ? r9(stock / effective) : NaN;
    const pct = r1Base > 0 ? r9((recent / r1Base - 1) * 100) : NaN;
    const lo = perish ? p.perishable_min_cover_weeks : p.stockout_cover_weeks;
    const hiCap = perish ? p.perishable_max_cover_weeks : p.overstock_cover_weeks;
    const high = pct > p.high_demand_threshold_pct;
    const stockout = cover < lo;
    const overstock = cover > hiCap;     // NaN comparisons are false, as intended

    // ---------------- exceptions ----------------
    const mine: Exc[] = [];
    const add = (code: string, blocking: boolean, detail: string) => mine.push({ sku_id: s.sku_id, code, blocking, detail });
    const newSku = history < p.min_history_weeks;
    if (newSku) add("NEW_SKU", true, `Only ${history} weeks of sales history (need ${p.min_history_weeks})`);
    const noDemand = !newSku && baseline === 0 && (stock ?? 0) > 0;
    if (noDemand) add("NO_DEMAND_STOCK_HELD", true, `No sales in the last ${p.baseline_window_weeks} weeks but ${stock} units on hand`);
    const badStock = stock === null || stock < 0;
    if (badStock) add("DATA_ISSUE", true, stock === null ? "Inventory missing" : `Negative stock (${stock})`);
    const overlap = stockout && overstock;
    if (overlap) add("DATA_ISSUE", true, "Stockout and overstock limits overlap: check config");
    if (s.filled_weeks > p.max_filled_weeks) add("DATA_ISSUE", false, `${s.filled_weeks} missing sales weeks were filled with 0`);
    if (W >= 2) {
      const last = series[W - 1], prev = series[W - 2];
      if (!Number.isNaN(last) && !Number.isNaN(prev)) {
        const wow = prev > 0 ? r9(((last - prev) / prev) * 100) : last > 0 ? Infinity : 0;
        if (Math.abs(wow) > p.sku_wow_spike_pct) {
          add("SKU_SPIKE_OR_DROP", false, `Week-on-week change ${Number.isFinite(wow) ? (wow >= 0 ? "+" : "") + wow.toFixed(0) : "inf"}% (${Math.round(prev)} -> ${Math.round(last)} units)`);
        }
      }
    }
    const an = anomaliesBySku.get(s.sku_id);
    if (an?.length) {
      let worst = an[0];
      for (const a of an) if (Math.abs(a.z) + a.drop_pct > Math.abs(worst.z) + worst.drop_pct) worst = a;
      add("DISTRIBUTOR_ANOMALY", false, `${an.length} distributor(s) unusual; e.g. ${worst.distributor_id} sold ${Math.round(worst.latest)} vs avg ${worst.trailing_mean.toFixed(0)} (z=${worst.z.toFixed(1)}, drop ${worst.drop_pct.toFixed(0)}%)`);
    }
    const blocked = mine.some((e) => e.blocking);

    // ---------------- decision table ----------------
    let action: Action = "NO_ACTION";
    let mult: number | null = null;
    let priority: Rec["priority"] = "";
    const conflict = !stockout && high && overstock;
    if (stockout && high && !overstock) { action = "REORDER_NOW"; mult = p.high_demand_reorder_multiplier; priority = "P1"; }
    else if (stockout && !high && !overstock) { action = "REORDER_NOW"; mult = 1; priority = "P1"; }
    else if (!stockout && high && !overstock) { action = "REORDER_HIGH_DEMAND"; mult = p.high_demand_reorder_multiplier; priority = "P2"; }
    else if (!stockout && !high && overstock) { action = "PAUSE_ORDER"; mult = 0; priority = "P3"; }
    else if (conflict) { action = "PAUSE_REVIEW"; mult = 0; priority = "P2"; }
    if (conflict && !blocked) add("RULE_CONFLICT", false, `High demand (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%) but cover ${cover.toFixed(1)} weeks is above the overstock limit`);
    if (blocked) { action = "EXCEPTION"; mult = null; priority = "EX"; }

    // ---------------- quantity with cap ----------------
    const isReorder = REORDER_ACTIONS.includes(action);
    const noStdQty = s.standard_qty === null;
    const target = perish ? p.perishable_target_cover_weeks : p.target_cover_weeks;
    const baseQty = noStdQty ? Math.max(0, target - (Number.isNaN(cover) ? 0 : cover)) * (Number.isNaN(effective) ? 0 : effective) : s.standard_qty!;
    const rawQty = isReorder ? Math.ceil(r9(baseQty * (mult ?? 0))) : 0;
    const allowed = Math.max(0, Math.floor(r9(hiCap * (Number.isNaN(effective) ? 0 : effective) - (Number.isNaN(stockWith) ? 0 : stockWith))));
    const qty = isReorder ? Math.min(rawQty, allowed) : 0;
    const capped = isReorder && rawQty > allowed;

    // ---------------- value at risk (units unless a price exists) ----------------
    let varUnits = 0;
    if (!blocked) {
      if (stockout) varUnits = Math.max(0, (lo - cover) * effective);
      else if (overstock) varUnits = Math.max(0, (cover - hiCap) * effective);
      else if (high) varUnits = Math.max(0, recent - r1Base);
    }
    const hasPrice = s.unit_price !== null;
    const value = hasPrice ? varUnits * s.unit_price! : varUnits;

    // ---------------- flags, reasons ----------------
    const flags: string[] = [];
    const reasons: Reason[] = [];
    if (!blocked) {
      if (high) { flags.push("HIGH_DEMAND"); reasons.push({ rule: "R1", code: "HIGH_DEMAND", recent_vs_baseline_pct: pct, threshold_pct: p.high_demand_threshold_pct, baseline_used: p.festival_uplift_applies_to_r1_baseline ? "effective" : "raw" }); }
      if (stockout) { flags.push("STOCKOUT_RISK"); reasons.push({ rule: "R2", code: "STOCKOUT_RISK", cover_weeks: cover, limit_weeks: lo, perishable: perish }); }
      if (overstock) { flags.push("OVERSTOCK_RISK"); reasons.push({ rule: "R3", code: "OVERSTOCK_RISK", cover_weeks: cover, limit_weeks: hiCap, perishable: perish }); }
      if (festival && (stockout || overstock || high || action === "NO_ACTION")) reasons.push({ rule: "R4", code: "FESTIVAL_UPLIFT", uplift_pct: p.festival_uplift_pct });
      if (capped) reasons.push({ rule: "QTY_CAP", code: "QTY_CAPPED", uncapped_qty: rawQty, capped_qty: qty, ceiling_weeks: hiCap });
    }
    for (const e of mine) reasons.push({ rule: "EXCEPTION", code: e.code });
    exc.push(...mine);

    const hasAction = [...REORDER_ACTIONS, "PAUSE_ORDER", "PAUSE_REVIEW"].includes(action);
    recs.push({
      rank: 0, sku_id: s.sku_id, sku_name: s.sku_name, category: s.category, perishable: perish, distributor_id: s.distributor_id,
      stock, standard_qty: s.standard_qty, history_weeks: history,
      baseline_avg_weekly: fin(baseline), recent_avg_weekly: fin(recent), effective_avg_weekly: fin(effective),
      festival_active: festival, cover_weeks: fin(cover), cover_weeks_without_on_order: fin(coverWo), recent_vs_baseline_pct: fin(pct),
      flags, action, qty_multiplier: mult, base_qty: isReorder ? baseQty : null, recommended_qty: qty, qty_capped: capped,
      priority, value_at_risk: value, value_unit: hasPrice ? "INR" : "units",
      exception_codes: mine.map((e) => e.code), review_before_approving: hasAction && mine.length > 0, reasons,
      fallbacks: noStdQty && isReorder ? ["STANDARD_QTY_MISSING"] : [],
    });
  }

  // Ranking: priority tier, then perishables first, then value at risk (units if no price), then SKU id.
  recs.sort((a, b) =>
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    Number(b.perishable) - Number(a.perishable) ||
    b.value_at_risk - a.value_at_risk ||
    (a.sku_id < b.sku_id ? -1 : a.sku_id > b.sku_id ? 1 : 0));
  recs.forEach((r, i) => (r.rank = i + 1));
  return { recs, exceptions: exc, runFallbacks };
}
