// Every hard stop and soft fix in RUBRIC section 7.
import { describe, expect, it } from "vitest";
import { clean, hardStops } from "@/lib/cleanup";
import { SCHEMA_MAP } from "@/lib/config";
import { loadFromTexts, SchemaError } from "@/lib/ingest";
import { isoWeekLabel, lastCompleteWeekStart, parseIsoWeek } from "@/lib/dates";
import { P, rawSeed, seedTexts } from "./helpers";

const run = (raw = rawSeed(), asOf?: string) => clean(raw, P, SCHEMA_MAP, asOf);
const codes = (r: { issues: { code: string; severity: string }[] }, sev?: string) => new Set(r.issues.filter((i) => !sev || i.severity === sev).map((i) => i.code));
/** Edit seed CSV text, then reload through the schema map. */
const edited = (fn: (t: Record<string, string>) => void) => { const t = seedTexts(); fn(t); return loadFromTexts(t, SCHEMA_MAP); };
const setCell = (csv: string, row: number, col: number, v: string) => { const ls = csv.trim().split("\n"); const c = ls[row].split(","); c[col] = v; ls[row] = c.join(","); return ls.join("\n") + "\n"; };

describe("seed defaults", () => {
  it("as-of defaults to inventory date; W42 is the last complete week; October is festival", () => {
    const r = run();
    expect(hardStops(r)).toEqual([]);
    expect(r.metrics).toMatchObject({ last_week: "2026-W42", as_of: "2026-10-19", sales_age_days: 1, inventory_age_days: 0, festival_active: true });
    expect(r.data!.sku.length).toBe(15); expect(r.data!.weekStarts.length).toBe(16); expect(r.data!.distWeekly).toBeNull();
    expect(r.fallbacks).toEqual(expect.arrayContaining(["NO_UNIT_PRICE", "NO_LEAD_TIME", "NO_ON_ORDER_UNITS", "NO_DISTRIBUTOR_IN_SALES"]));
  });
  it("ISO week helpers", () => {
    expect(parseIsoWeek("2026-W42")).toBe("2026-10-12"); expect(isoWeekLabel("2026-10-12")).toBe("2026-W42");
    expect(isoWeekLabel("2024-12-30")).toBe("2025-W01"); expect(parseIsoWeek("2020-W53")).toBe("2020-12-28");
    expect(lastCompleteWeekStart("2026-10-19")).toBe("2026-10-12"); expect(lastCompleteWeekStart("2026-10-22")).toBe("2026-10-12");
  });
});

describe("hard stops", () => {
  it("stale data is measured against the as-of date, not the wall clock", () => {
    const r = run(rawSeed(), "2026-11-16");
    expect(codes(r, "HARD_STOP")).toEqual(new Set(["STALE_SALES", "STALE_INVENTORY"])); expect(r.data).toBeNull();
  });
  it("more than 20% of SKUs without inventory", () => {
    const r = run(edited((t) => { t["current_inventory.csv"] = t["current_inventory.csv"].trim().split("\n").slice(0, 12).join("\n") + "\n"; }));   // 4 of 15 missing
    expect(codes(r, "HARD_STOP")).toContain("TOO_MANY_SKUS_WITHOUT_INVENTORY");
  });
  it("up to 20% is only a soft fix", () => {
    const r = run(edited((t) => { t["current_inventory.csv"] = t["current_inventory.csv"].trim().split("\n").slice(0, 14).join("\n") + "\n"; }));   // 2 of 15
    expect(hardStops(r)).toEqual([]); expect(codes(r, "SOFT_FIX")).toContain("MISSING_INVENTORY_ROW");
  });
  it("missing required column fails loudly", () => {
    const t = seedTexts(); t["weekly_sales.csv"] = t["weekly_sales.csv"].replace("Units_Sold", "Units");
    expect(() => loadFromTexts(t, SCHEMA_MAP)).toThrow(SchemaError); expect(() => loadFromTexts(t, SCHEMA_MAP)).toThrow(/Units_Sold/);
  });
  it("missing required file fails loudly", () => {
    const t = seedTexts(); delete (t as Record<string, string | undefined>)["calendar.csv"];
    expect(() => loadFromTexts(t, SCHEMA_MAP)).toThrow(/calendar.csv/);
  });
  it("bad week format", () => {
    const r = run(edited((t) => { t["weekly_sales.csv"] = setCell(t["weekly_sales.csv"], 1, 1, "week-27"); }));
    expect(codes(r, "HARD_STOP")).toContain("BAD_WEEK_FORMAT");
  });
});

describe("soft fixes", () => {
  it("IDs are normalised", () => {
    const r = run(edited((t) => { t["weekly_sales.csv"] = setCell(t["weekly_sales.csv"], 1, 0, " sku-1 "); }));
    expect(codes(r, "SOFT_FIX")).toContain("IDS_NORMALISED"); expect(r.data!.series.has("SKU001")).toBe(true); expect(codes(r)).not.toContain("UNKNOWN_SKU_SALES_QUARANTINED");
  });
  it("duplicate rows keep the last", () => {
    const r = run(edited((t) => { t["weekly_sales.csv"] += "SKU001,2026-W27,999\n"; }));
    expect(r.issues.find((i) => i.code === "DUPLICATE_SALES_ROWS")!.count).toBe(1); expect(r.data!.series.get("SKU001")![0]).toBe(999);
  });
  it("unknown SKUs are quarantined in sales and inventory", () => {
    const r = run(edited((t) => { t["weekly_sales.csv"] += "SKU999,2026-W27,5\n"; t["current_inventory.csv"] += "SKU998,Pune Central Warehouse,5,2026-10-19\n"; }));
    expect(codes(r, "SOFT_FIX")).toEqual(expect.objectContaining(new Set(["UNKNOWN_SKU_SALES_QUARANTINED", "UNKNOWN_SKU_INVENTORY_QUARANTINED"])));
    expect(r.data!.series.has("SKU999")).toBe(false);
  });
  it("negative units are netted and floored at 0", () => {
    const r = run(edited((t) => { t["weekly_sales.csv"] = setCell(t["weekly_sales.csv"], 1, 2, "-50"); }));
    expect(codes(r, "SOFT_FIX")).toContain("NEGATIVE_UNITS_NETTED"); expect(r.data!.series.get("SKU001")![0]).toBe(0);
  });
  it("missing weeks are filled with 0 and the SKU is flagged above 2", () => {
    const r = run(edited((t) => { t["weekly_sales.csv"] = t["weekly_sales.csv"].split("\n").filter((l) => !(l.startsWith("SKU002,") && /W3[012]/.test(l))).join("\n"); }));
    expect(r.data!.filledWeeks.SKU002).toBe(3); expect(r.issues.some((i) => i.code === "SKU_MANY_WEEKS_FILLED" && i.sku_id === "SKU002")).toBe(true);
    expect(r.data!.series.get("SKU002")![3]).toBe(0);
  });
  it("missing standard qty uses the fallback", () => {
    const r = run(edited((t) => { t["sku_master.csv"] = setCell(t["sku_master.csv"], 1, 4, ""); }));
    expect(r.fallbacks).toContain("STANDARD_QTY_MISSING"); expect(r.data!.sku[0].standard_qty).toBeNull();
  });
  it("a Distributor_ID column in sales switches the anomaly path on", () => {
    const m = new Map(seedTexts()["sku_master.csv"].trim().split("\n").slice(1).map((l) => { const c = l.split(","); return [c[0], c[6]] as const; }));
    const r = run(edited((t) => { const ls = t["weekly_sales.csv"].trim().split("\n"); t["weekly_sales.csv"] = ls.map((l, i) => i === 0 ? l + ",Distributor_ID" : `${l},${m.get(l.split(",")[0])}`).join("\n") + "\n"; }));
    expect(r.data!.distWeekly).not.toBeNull(); expect(r.fallbacks).not.toContain("NO_DISTRIBUTOR_IN_SALES");
  });
  it("festival flag follows the calendar and the as-of month", () => {
    expect(run(rawSeed(), "2026-09-14").data!.festivalActive).toBe(false);
    expect(run(rawSeed(), "2026-10-19").data!.festivalActive).toBe(true);
  });
  it("festival falls back to config months when the calendar lacks the month", () => {
    const r = run(edited((t) => { t["calendar.csv"] = t["calendar.csv"].split("\n").filter((l) => !l.startsWith("2026")).join("\n"); }));
    expect(r.fallbacks).toContain("FESTIVAL_FROM_CONFIG"); expect(r.data!.festivalActive).toBe(true);
  });
});
