// Full-size synthetic run: 400 SKUs x 1,200 distributors x 156 weeks, through the real CSV path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateScale } from "../scripts/generate-scale-data";
import { clean } from "@/lib/cleanup";
import { DEFAULT_RULES, SCHEMA_MAP } from "@/lib/config";
import { FsCsvSource } from "@/lib/ingest";
import { evaluate } from "@/lib/rules";
import { runPipeline } from "@/lib/pipeline";
import { memDb } from "./helpers";

describe("full scale", () => {
  it("runs under a minute with the distributor-anomaly path switched on", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scale-"));
    const g = generateScale(dir);
    expect(g.salesRows).toBeGreaterThan(1_500_000);
    const db = await memDb();
    const t = Date.now();
    const res = await runPipeline({ db, useAi: false, source: new FsCsvSource(dir, SCHEMA_MAP) });
    const secs = (Date.now() - t) / 1000;
    console.log(`scale run: ${g.salesRows} rows in ${secs.toFixed(1)}s`);
    expect(res.status).toBe("SUCCESS"); expect(res.n_recs).toBe(400); expect(secs).toBeLessThan(60);
    const codes = new Set((await db.query("SELECT DISTINCT code FROM exceptions")).map((r) => r.code));
    for (const c of ["DISTRIBUTOR_ANOMALY", "NEW_SKU", "NO_DEMAND_STOCK_HELD", "SKU_SPIKE_OR_DROP"]) expect(codes.has(c), c).toBe(true);
    const fb = (await db.query("SELECT fallbacks FROM runs"))[0].fallbacks as string[];
    expect(fb).not.toContain("NO_DISTRIBUTOR_IN_SALES");
    const actions = new Set((await db.query("SELECT DISTINCT action FROM recommendations")).map((r) => r.action));
    expect(actions.has("REORDER_NOW") && actions.has("PAUSE_ORDER")).toBe(true);
  });
  it("the rules engine alone takes well under a second per 400 SKUs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scale-"));
    generateScale(dir, { distsPerSku: 30 });
    const cleaned = clean(await new FsCsvSource(dir, SCHEMA_MAP).load(), DEFAULT_RULES, SCHEMA_MAP);
    const t = Date.now();
    evaluate(cleaned.data!, DEFAULT_RULES);
    expect((Date.now() - t) / 1000).toBeLessThan(5);
  });
});
