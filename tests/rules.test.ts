// RUBRIC section 10 worked examples (1-10, 2b), quantity cap, exceptions, ranking, distributor anomaly.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, type Rec } from "@/lib/rules";
import { rulesWith } from "@/lib/config";
import type { DistTable } from "@/lib/cleanup";
import { addDays } from "@/lib/dates";
import { makeData, P, type Row } from "./helpers";

const one = (row: Omit<Row, "sku_id">, festival = false, params = P) => {
  const res = evaluate(makeData([{ sku_id: "X", ...row }], { festival }), params);
  return { r: res.recs[0] as Rec, exc: res.exceptions, res };
};

describe("RUBRIC section 10 worked examples", () => {
  it("1: high demand", () => {
    const { r } = one({ baseline: 100, recent: 130, stock: 800 });
    expect(r.recent_vs_baseline_pct).toBe(30); expect(r.cover_weeks).toBe(8);
    expect(r.flags).toEqual(["HIGH_DEMAND"]); expect(r.action).toBe("REORDER_HIGH_DEMAND"); expect(r.recommended_qty).toBe(450); expect(r.priority).toBe("P2");
  });
  it("2: festival month, default toggle", () => {
    const { r } = one({ baseline: 100, recent: 140, stock: 700 }, true);
    expect(r.recent_vs_baseline_pct).toBe(40); expect(r.cover_weeks).toBe(5.6);
    expect(r.flags).toEqual(["HIGH_DEMAND", "STOCKOUT_RISK"]); expect(r.action).toBe("REORDER_NOW"); expect(r.recommended_qty).toBe(450); expect(r.priority).toBe("P1");
  });
  it("2 (control): without the uplift the stockout would be missed", () => {
    const { r } = one({ baseline: 100, recent: 140, stock: 700 }, false);
    expect(r.cover_weeks).toBe(7); expect(r.flags).not.toContain("STOCKOUT_RISK");
  });
  it("2b: uplift also applies to the R1 baseline", () => {
    const { r } = one({ baseline: 100, recent: 140, stock: 700 }, true, rulesWith({ festival_uplift_applies_to_r1_baseline: true }));
    expect(r.recent_vs_baseline_pct).toBe(12); expect(r.flags).toEqual(["STOCKOUT_RISK"]); expect(r.action).toBe("REORDER_NOW"); expect(r.recommended_qty).toBe(300);
  });
  it("3a/3b/3c: perishable windows", () => {
    const a = one({ baseline: 200, stock: 500, perishable: true }).r;
    const b = one({ baseline: 200, stock: 700, perishable: true }).r;
    const c = one({ baseline: 200, stock: 900, perishable: true }).r;
    expect([a.cover_weeks, a.action]).toEqual([2.5, "REORDER_NOW"]);
    expect([b.cover_weeks, b.action]).toEqual([3.5, "NO_ACTION"]);
    expect([c.cover_weeks, c.action]).toEqual([4.5, "PAUSE_ORDER"]);
  });
  it("4: overstock", () => {
    const { r } = one({ baseline: 50, stock: 800 });
    expect([r.cover_weeks, r.action, r.priority, r.recommended_qty]).toEqual([16, "PAUSE_ORDER", "P3", 0]);
  });
  it("5: rules conflict", () => {
    const { r, exc } = one({ baseline: 100, recent: 150, stock: 1500 });
    expect([r.action, r.priority]).toEqual(["PAUSE_REVIEW", "P2"]); expect(exc.map((e) => e.code)).toEqual(["RULE_CONFLICT"]); expect(r.review_before_approving).toBe(true);
  });
  it("6: reorder now with high demand", () => {
    const { r } = one({ baseline: 100, recent: 135, stock: 400 });
    expect([r.cover_weeks, r.action, r.recommended_qty, r.priority]).toEqual([4, "REORDER_NOW", 450, "P1"]);
  });
  it("7: NEW_SKU, no rule action", () => {
    const { r, exc } = one({ baseline: 100, stock: 400, history: 5 });
    expect(exc.map((e) => e.code)).toEqual(["NEW_SKU"]); expect(r.action).toBe("EXCEPTION"); expect(r.recommended_qty).toBe(0); expect(r.flags).toEqual([]);
  });
  it("8: NO_DEMAND_STOCK_HELD", () => {
    const { r, exc } = one({ baseline: 0, stock: 300 });
    expect(exc.map((e) => e.code)).toEqual(["NO_DEMAND_STOCK_HELD"]); expect(r.action).toBe("EXCEPTION");
  });
  it("9: boundary, cover exactly 6.0 is not a stockout", () => {
    const { r } = one({ baseline: 100, stock: 600 });
    expect(r.cover_weeks).toBe(6); expect(r.flags).not.toContain("STOCKOUT_RISK"); expect(r.action).toBe("NO_ACTION");
  });
  it("10: boundary, exactly +20% is not high demand", () => {
    const { r } = one({ baseline: 100, recent: 120, stock: 800 });
    expect(r.recent_vs_baseline_pct).toBe(20); expect(r.flags).not.toContain("HIGH_DEMAND");
  });
});

describe("boundaries, cap and fallbacks", () => {
  it("overstock boundary at exactly 14 weeks", () => {
    const { r } = one({ baseline: 100, stock: 1400 });
    expect([r.cover_weeks, r.action]).toEqual([14, "NO_ACTION"]);
  });
  it("cap stops a perishable reorder creating overstock", () => {
    const { r } = one({ baseline: 200, stock: 500, perishable: true, std: 400 });   // 500+400 = 4.5 weeks > 4
    expect([r.action, r.recommended_qty, r.qty_capped]).toEqual(["REORDER_NOW", 300, true]);
    expect(r.reasons.some((x) => x.code === "QTY_CAPPED")).toBe(true);
    expect((500 + r.recommended_qty) / 200).toBeLessThanOrEqual(4);
  });
  it("cap applies to the high-demand multiplier too", () => {
    const { r } = one({ baseline: 200, recent: 300, stock: 500, perishable: true, std: 300 });
    expect([r.recommended_qty, r.qty_capped]).toEqual([300, true]);   // raw 450, ceiling 4*200-500
  });
  it("missing standard qty falls back to the target-cover formula", () => {
    const { r } = one({ baseline: 100, stock: 200, std: null });
    expect(r.recommended_qty).toBe(600); expect(r.fallbacks).toContain("STANDARD_QTY_MISSING");
  });
  it("negative and missing stock are blocking DATA_ISSUEs", () => {
    const res = evaluate(makeData([{ sku_id: "A", baseline: 100, stock: -5 }, { sku_id: "B", baseline: 100, stock: null }]), P);
    expect(new Set(res.exceptions.map((e) => e.code))).toEqual(new Set(["DATA_ISSUE"]));
    expect(new Set(res.recs.map((r) => r.action))).toEqual(new Set(["EXCEPTION"]));
  });
  it("SKU spike is non-blocking and marks review", () => {
    const d = makeData([{ sku_id: "X", baseline: 100, stock: 300 }]);
    d.series.get("X")![15] = 400;
    const res = evaluate(d, P);
    expect(res.exceptions.map((e) => e.code)).toContain("SKU_SPIKE_OR_DROP");
    expect(res.recs[0].action).toBe("REORDER_NOW"); expect(res.recs[0].review_before_approving).toBe(true);
  });
  it("gap-filled SKU is flagged but keeps its rule action", () => {
    const res = evaluate(makeData([{ sku_id: "X", baseline: 100, stock: 300, filled: 3 }]), P);
    expect(res.exceptions[0]).toMatchObject({ code: "DATA_ISSUE", blocking: false }); expect(res.recs[0].action).toBe("REORDER_NOW");
  });
  it("value at risk is in units without a price", () => {
    const { r } = one({ baseline: 100, stock: 400 });
    expect([r.value_unit, r.value_at_risk]).toEqual(["units", 200]);    // (6-4)*100
  });
});

describe("ranking", () => {
  it("priority, then perishable, then value at risk", () => {
    const res = evaluate(makeData([
      { sku_id: "NP_SMALL", baseline: 100, stock: 500 }, { sku_id: "NP_BIG", baseline: 500, stock: 500 },
      { sku_id: "PERISH", baseline: 100, stock: 290, perishable: true }, { sku_id: "OVER", baseline: 50, stock: 800 }, { sku_id: "OK", baseline: 100, stock: 800 },
    ]), P);
    expect(res.recs.map((r) => r.sku_id)).toEqual(["PERISH", "NP_BIG", "NP_SMALL", "OVER", "OK"]);
    expect(res.recs.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("determinism boundary", () => {
  it("rules.ts has no network or LLM imports", () => {
    const src = fs.readFileSync("lib/rules.ts", "utf8");
    for (const banned of ["fetch(", "node:http", "node:net", "genai", "neon", "process.env"]) expect(src).not.toContain(banned);
  });
});

describe("distributor anomaly", () => {
  const dist = (dropLast?: string): DistTable => {
    const t: DistTable = { sku: [], dist: [], weekIdx: new Int32Array(48), units: new Float64Array(48), length: 48 };
    let n = 0;
    for (const [d, level] of [["D1", 100], ["D2", 80], ["D3", 120]] as const) for (let w = 0; w < 16; w++) {
      t.sku.push("X"); t.dist.push(d); t.weekIdx[n] = w;
      t.units[n] = dropLast === d && w === 15 ? level * 0.4 : level + (w % 3) * 2; n++;
    }
    return t;
  };
  it("is off without a distributor column", () => {
    const res = evaluate(makeData([{ sku_id: "X", baseline: 100, stock: 800 }]), P);
    expect(res.exceptions.map((e) => e.code)).not.toContain("DISTRIBUTOR_ANOMALY");
    expect(res.runFallbacks).toContain("DISTRIBUTOR_ANOMALY_DISABLED_NO_DISTRIBUTOR_COLUMN");
  });
  it("switches on and flags a 60% drop", () => {
    const res = evaluate(makeData([{ sku_id: "X", baseline: 100, stock: 800 }], { dist: dist("D2") }), P);
    expect(res.exceptions.map((e) => e.code)).toContain("DISTRIBUTOR_ANOMALY");
    expect(res.runFallbacks).not.toContain("DISTRIBUTOR_ANOMALY_DISABLED_NO_DISTRIBUTOR_COLUMN");
  });
  it("stays quiet for steady distributors", () => {
    const res = evaluate(makeData([{ sku_id: "X", baseline: 100, stock: 800 }], { dist: dist() }), P);
    expect(res.exceptions.map((e) => e.code)).not.toContain("DISTRIBUTOR_ANOMALY");
  });
});
void addDays;
