// End to end on in-memory Postgres: golden table (RUBRIC 10b), kill switch, decisions, PO drafts, audit, Gemini fallback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runPipeline } from "@/lib/pipeline";
import { createPendingPoDrafts, approve, reject, editQuantity, DecisionError } from "@/lib/decisions";
import { DryRunZohoClient, ZohoInventoryClient, createPoDraft, getPoClient } from "@/lib/po";
import { KillSwitchEngaged, isEngaged, setKillSwitch } from "@/lib/killswitch";
import { rulesWith, SCHEMA_MAP } from "@/lib/config";
import { SYSTEM_PROMPT, type AiClient } from "@/lib/ai";
import { TextCsvSource } from "@/lib/ingest";
import type { Db } from "@/lib/db";
import { memDb, seedTexts } from "./helpers";

let db: Db;
let poDir: string;
let client: DryRunZohoClient;
beforeEach(async () => { db = await memDb(); poDir = fs.mkdtempSync(path.join(os.tmpdir(), "po-")); client = new DryRunZohoClient(poDir); });

const recs = async (runId: number) => Object.fromEntries((await db.query("SELECT * FROM recommendations WHERE run_id=$1", [runId])).map((r) => [r.sku_id, r]));
const run = (o: Parameters<typeof runPipeline>[0] = {}) => runPipeline({ db, useAi: false, ...o });

describe("golden seed results (RUBRIC 10b), rules only", () => {
  it("reproduces the table exactly", async () => {
    const res = await run();
    expect(res.status).toBe("SUCCESS");
    const r = await recs(res.run_id);
    const golden: Record<string, [number, number, string, number, string[]]> = {
      SKU001: [3.35, 21.4, "REORDER_NOW", 750, ["HIGH_DEMAND", "STOCKOUT_RISK"]],
      SKU003: [4.36, 0.2, "REORDER_NOW", 300, ["STOCKOUT_RISK"]],
      SKU004: [1.8, 1.5, "REORDER_NOW", 150, ["STOCKOUT_RISK"]],
      SKU011: [1.8, 2.4, "REORDER_NOW", 500, ["STOCKOUT_RISK"]],
      SKU013: [3.17, -1.5, "REORDER_NOW", 120, ["STOCKOUT_RISK"]],
      SKU006: [22.23, 1.7, "PAUSE_ORDER", 0, ["OVERSTOCK_RISK"]],
      SKU007: [4.08, 9.9, "PAUSE_ORDER", 0, ["OVERSTOCK_RISK"]],
    };
    for (const [sku, [cover, pct, action, qty, flags]] of Object.entries(golden)) {
      expect(+r[sku].cover_weeks.toFixed(2), sku).toBe(cover); expect(+r[sku].recent_vs_baseline_pct.toFixed(1), sku).toBe(pct);
      expect([r[sku].action, r[sku].recommended_qty, r[sku].flags], sku).toEqual([action, qty, flags]);
    }
    expect(r.SKU001.priority).toBe("P1");
    for (const sku of ["SKU002", "SKU005", "SKU008", "SKU009", "SKU010", "SKU012", "SKU014", "SKU015"]) {
      expect(r[sku].action, sku).toBe("NO_ACTION");
      expect(+r[sku].cover_weeks.toFixed(2)).toBeGreaterThanOrEqual(6.77); expect(+r[sku].cover_weeks.toFixed(2)).toBeLessThanOrEqual(11.46);
      expect(Math.abs(r[sku].recent_vs_baseline_pct)).toBeLessThanOrEqual(10);
    }
    expect((await db.query("SELECT count(*)::int n FROM exceptions"))[0].n).toBe(0);
    const row = (await db.query("SELECT * FROM runs"))[0];
    expect([row.last_week, row.festival_active, row.as_of]).toEqual(["2026-W42", true, "2026-10-19"]);
    expect(row.fallbacks).toEqual(expect.arrayContaining(["NO_UNIT_PRICE", "NO_LEAD_TIME", "NO_ON_ORDER_UNITS", "NO_DISTRIBUTOR_IN_SALES"]));
  });

  it("festival uplift changes exactly one outcome on the seed (SKU002)", async () => {
    const withUp = await recs((await run()).run_id);
    const noUp = await recs((await run({ rules: rulesWith({ festival_uplift_pct: 0 }) })).run_id);
    expect([withUp.SKU002.action, +withUp.SKU002.cover_weeks.toFixed(1)]).toEqual(["NO_ACTION", 11.5]);
    expect([noUp.SKU002.action, +noUp.SKU002.cover_weeks.toFixed(1)]).toEqual(["PAUSE_ORDER", 14.3]);
    expect(Object.keys(withUp).filter((k) => withUp[k].action !== noUp[k].action)).toEqual(["SKU002"]);
  });

  it("toggle on: SKU001 loses its high-demand flag (-2.8%) and drops to 500", async () => {
    const r = await recs((await run({ rules: rulesWith({ festival_uplift_applies_to_r1_baseline: true }) })).run_id);
    expect(+r.SKU001.recent_vs_baseline_pct.toFixed(1)).toBe(-2.8); expect(r.SKU001.flags).not.toContain("HIGH_DEMAND"); expect(r.SKU001.recommended_qty).toBe(500);
  });

  it("as-of replay in a non-festival month turns the uplift off", async () => {
    const res = await run({ asOf: "2026-09-14" });
    const row = (await db.query("SELECT * FROM runs WHERE run_id=$1", [res.run_id]))[0];
    expect([row.status, row.festival_active, row.last_week]).toEqual(["SUCCESS", false, "2026-W37"]);
  });
});

describe("failed runs", () => {
  it("a hard stop gives a visible FAILED run and no recommendations", async () => {
    const res = await run({ asOf: "2026-12-01" });
    expect(res.status).toBe("FAILED");
    expect((await db.query("SELECT count(*)::int n FROM recommendations"))[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int n FROM data_quality_issues WHERE severity='HARD_STOP'"))[0].n).toBeGreaterThanOrEqual(1);
  });
  it("a schema error gives a FAILED run naming the column", async () => {
    const t = seedTexts(); t["current_inventory.csv"] = t["current_inventory.csv"].replace("Units_On_Hand", "Qty");
    const res = await run({ source: new TextCsvSource(t, SCHEMA_MAP) });
    expect(res.status).toBe("FAILED"); expect(res.message).toContain("Units_On_Hand");
    expect((await db.query("SELECT count(*)::int n FROM recommendations"))[0].n).toBe(0);
  });
  it("uploaded exports take priority over the bundled seed data", async () => {
    for (const [name, content] of Object.entries(seedTexts())) await db.query("INSERT INTO data_files(name,content,uploaded_at,actor) VALUES($1,$2,'x','t')", [name, content]);
    await run();
    expect((await db.query("SELECT data_source FROM runs"))[0].data_source).toBe("uploaded exports");
  });
});

describe("kill switch", () => {
  it("blocks a scheduled run and persists", async () => {
    await setKillSwitch(db, true, "raghav", "demo");
    expect(await isEngaged(db)).toBe(true);
    const res = await run({ trigger: "scheduled", actor: "scheduler" });
    expect(res.status).toBe("SKIPPED_KILL_SWITCH");
    expect((await db.query("SELECT count(*)::int n FROM recommendations"))[0].n).toBe(0);
    await setKillSwitch(db, false, "raghav");
    expect((await run()).status).toBe("SUCCESS");
  });
  it("blocks PO creation; approval is recorded and drafts can be made after release", async () => {
    const r = await recs((await run()).run_id);
    const id = r.SKU001.rec_id;
    await setKillSwitch(db, true, "raghav");
    expect(await approve(db, [id], "raghav", client)).toEqual([null]);
    expect((await db.query("SELECT status FROM recommendations WHERE rec_id=$1", [id]))[0].status).toBe("APPROVED");
    expect((await db.query("SELECT count(*)::int n FROM po_drafts"))[0].n).toBe(0);
    await expect(createPoDraft(db, id, client, "raghav")).rejects.toBeInstanceOf(KillSwitchEngaged);
    await expect(createPendingPoDrafts(db, "raghav", client)).rejects.toBeInstanceOf(KillSwitchEngaged);
    await setKillSwitch(db, false, "raghav");
    expect(await createPendingPoDrafts(db, "raghav", client)).toHaveLength(1);
    expect(fs.readdirSync(poDir).length).toBe(1);
  });
});

describe("decisions and purchase orders", () => {
  it("approve creates a PO draft JSON and audit entries", async () => {
    const r = await recs((await run()).run_id);
    const [po] = await approve(db, [r.SKU001.rec_id], "raghav", client);
    expect(po).toMatch(/^FR-PO-/);
    const payload = JSON.parse(fs.readFileSync(path.join(poDir, `${po}.json`), "utf8"));
    expect(payload.status).toBe("draft"); expect(payload.line_items[0]).toMatchObject({ sku: "SKU001", quantity: 750 });
    expect((await db.query("SELECT status FROM recommendations WHERE rec_id=$1", [r.SKU001.rec_id]))[0].status).toBe("PO_DRAFTED");
    const events = new Set((await db.query("SELECT event_type FROM audit_log")).map((e) => e.event_type));
    for (const e of ["RUN_STARTED", "RUN_SUCCESS", "RECOMMENDATION_CREATED", "APPROVE", "PO_DRAFTED"]) expect(events.has(e), e).toBe(true);
  });
  it("nothing becomes a PO without Approve", async () => {
    const r = await recs((await run()).run_id);
    expect((await db.query("SELECT count(*)::int n FROM po_drafts"))[0].n).toBe(0);
    await expect(createPoDraft(db, r.SKU001.rec_id, client, "x")).rejects.toThrow(/not APPROVED/);
  });
  it("approving a pause needs no PO", async () => {
    const r = await recs((await run()).run_id);
    expect(await approve(db, [r.SKU006.rec_id], "raghav", client)).toEqual([null]);
    expect((await db.query("SELECT count(*)::int n FROM po_drafts"))[0].n).toBe(0);
  });
  it("exception-only and no-action rows cannot be approved", async () => {
    const r = await recs((await run()).run_id);
    await expect(approve(db, [r.SKU002.rec_id], "raghav", client)).rejects.toBeInstanceOf(DecisionError);
  });
  it("reject and edit need a reason code, and overrides are queryable", async () => {
    const r = await recs((await run()).run_id);
    await expect(reject(db, [r.SKU003.rec_id], "raghav", "")).rejects.toBeInstanceOf(DecisionError);
    await expect(editQuantity(db, r.SKU004.rec_id, 100, "raghav", "bogus")).rejects.toBeInstanceOf(DecisionError);
    await reject(db, [r.SKU003.rec_id], "raghav", "supplier_issue", "supplier on strike");
    await editQuantity(db, r.SKU004.rec_id, 100, "raghav", "market_knowledge");
    const [po] = await approve(db, [r.SKU004.rec_id], "raghav", client);
    expect(JSON.parse(fs.readFileSync(path.join(poDir, `${po}.json`), "utf8")).line_items[0].quantity).toBe(100);
    const o = await db.query("SELECT decision, reason_code, original_qty, final_qty FROM decisions WHERE decision IN ('REJECT','EDIT') ORDER BY id");
    expect(o.map((x) => x.decision)).toEqual(["REJECT", "EDIT"]); expect([o[1].original_qty, o[1].final_qty]).toEqual([150, 100]);
    await expect(approve(db, [r.SKU003.rec_id], "raghav", client)).rejects.toBeInstanceOf(DecisionError);
  });
  it("a new run supersedes pending rows", async () => {
    const a = (await run()).run_id; const b = (await run()).run_id;
    expect(new Set((await db.query("SELECT status FROM recommendations WHERE run_id=$1", [a])).map((x) => x.status))).toEqual(new Set(["SUPERSEDED"]));
    expect(new Set((await db.query("SELECT status FROM recommendations WHERE run_id=$1", [b])).map((x) => x.status))).toEqual(new Set(["PENDING"]));
  });
  it("the live Zoho client is disabled by default", async () => {
    delete process.env.ZOHO_PO_ENABLED;
    await expect(new ZohoInventoryClient().createPurchaseOrder("X", {} as any)).rejects.toThrow(/disabled/);
    expect(getPoClient()).toBeInstanceOf(DryRunZohoClient);
  });
});

// ------------------------------------------------------------------------ Gemini
type Behaviour = "good" | "fail" | "badjson" | "negative" | "disagree" | "alter";
const fake = (b: Behaviour): AiClient & { calls: string[] } => {
  const calls: string[] = [];
  return {
    models: ["primary-model", "fallback-model"], calls,
    async generate(model, _sys, prompt) {
      calls.push(model);
      if (b === "fail") throw new Error("503 UNAVAILABLE");
      if (b === "badjson") return "this is not json";
      const facts = JSON.parse(prompt.split("FACTS:\n")[1]);
      const k = { good: 1, disagree: 3, negative: -5, alter: 1 }[b];
      return JSON.stringify({ notes: facts.map((f: any) => ({
        sku_id: f.sku_id, confidence: "medium", forecast_next_4_weeks: Array(4).fill(Math.round((f.baseline_avg_weekly || 10) * k * 10) / 10),
        explanation: "Cover is low. Reorder now.", ...(b === "alter" ? { action: "PAUSE_ORDER", recommended_qty: 1 } : {}),
      })) });
    },
  };
};
const snapshot = async (runId: number) => (await db.query("SELECT sku_id, action, recommended_qty, flags, priority FROM recommendations WHERE run_id=$1 ORDER BY rank", [runId]));

describe("Gemini integration", () => {
  it.each(["fail", "badjson", "negative"] as Behaviour[])("%s degrades to rules-only after one retry on the fallback model", async (b) => {
    const base = await snapshot((await run()).run_id);
    const c = fake(b);
    const res = await runPipeline({ db, aiClient: c });
    expect(res.status).toBe("SUCCESS");
    const rows = await db.query("SELECT * FROM recommendations WHERE run_id=$1 AND action<>'NO_ACTION'", [res.run_id]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ai_status === "UNAVAILABLE" && r.ai_explanation === null)).toBe(true);
    expect(await snapshot(res.run_id)).toEqual(base);
    const calls = await db.query("SELECT attempt, model, status FROM ai_calls WHERE run_id=$1 ORDER BY id", [res.run_id]);
    expect(calls.map((x) => [x.attempt, x.model])).toEqual([[1, "primary-model"], [2, "fallback-model"]]); expect(calls.every((x) => x.status !== "OK")).toBe(true);
    expect(c.calls).toEqual(["primary-model", "fallback-model"]);
  });
  it("no key runs rules-only", async () => {
    const base = await snapshot((await run()).run_id);
    const res = await runPipeline({ db, aiClient: null });
    expect(res.status).toBe("SUCCESS");
    expect(new Set((await db.query("SELECT ai_status FROM recommendations WHERE run_id=$1 AND action<>'NO_ACTION'", [res.run_id])).map((r) => r.ai_status))).toEqual(new Set(["UNAVAILABLE"]));
    expect(await snapshot(res.run_id)).toEqual(base);
  });
  it("success adds notes but cannot change rules, and logs prompts and responses", async () => {
    const base = await snapshot((await run()).run_id);
    const res = await runPipeline({ db, aiClient: fake("alter") });     // the model tries to sneak action/qty fields in
    const rows = await db.query("SELECT * FROM recommendations WHERE run_id=$1", [res.run_id]);
    const ok = rows.filter((r) => r.ai_status === "OK");
    expect(ok).toHaveLength(7); expect(ok[0].ai_explanation).toBeTruthy(); expect(ok[0].ai_forecast).toHaveLength(4);
    expect(await snapshot(res.run_id)).toEqual(base);
    expect(rows.filter((r) => r.action === "NO_ACTION").every((r) => r.ai_status === "SKIPPED")).toBe(true);
    const log = await db.query("SELECT prompt, response FROM ai_calls WHERE run_id=$1", [res.run_id]);
    expect(log[0].prompt).toContain("FACTS"); expect(log[0].response).toBeTruthy();
  });
  it("flags forecast disagreement above 40% of the statistical baseline", async () => {
    const good = await db.query("SELECT forecast_disagrees d FROM recommendations WHERE run_id=$1 AND ai_status='OK'", [(await runPipeline({ db, aiClient: fake("good") })).run_id]);
    const bad = await db.query("SELECT forecast_disagrees d FROM recommendations WHERE run_id=$1 AND ai_status='OK'", [(await runPipeline({ db, aiClient: fake("disagree") })).run_id]);
    expect(good.some((r) => r.d)).toBe(false);      // baseline x1.0 vs stat x1.25: -20%
    expect(bad.length > 0 && bad.every((r) => r.d)).toBe(true);   // baseline x3.0 vs x1.25: +140%
  });
  it("the system prompt forbids changing rules, arithmetic and invented events", () => {
    const s = SYSTEM_PROMPT.toLowerCase();
    expect(s).toContain("may not change"); expect(s).toContain("do not do arithmetic"); expect(s).toContain("do not invent");
  });
  it("--no-ai makes no AI calls at all", async () => {
    const c = fake("good");
    await runPipeline({ db, useAi: false, aiClient: c });
    expect(c.calls).toEqual([]);
  });
});
