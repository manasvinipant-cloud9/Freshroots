// CLI: npm run run:pipeline -- [--as-of YYYY-MM-DD] [--no-ai] [--data-dir path]
import { ensureSchema, getDb } from "../lib/db";
import { runPipeline } from "../lib/pipeline";
import { FsCsvSource } from "../lib/ingest";
import { SCHEMA_MAP } from "../lib/config";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };

(async () => {
  await ensureSchema();
  const db = getDb();
  const dir = arg("--data-dir");
  const res = await runPipeline({ db, asOf: arg("--as-of") ?? null, useAi: !process.argv.includes("--no-ai"), trigger: "cli", source: dir ? new FsCsvSource(dir, SCHEMA_MAP, `files in ${dir}`) : undefined });
  console.log(`Run ${res.run_id}: ${res.status}. ${res.message}`);
  if (res.status === "SUCCESS") {
    const rows = await db.query("SELECT priority, sku_id, sku_name, action, recommended_qty, cover_weeks, recent_vs_baseline_pct, flags FROM recommendations WHERE run_id=$1 AND action<>'NO_ACTION' ORDER BY rank LIMIT 40", [res.run_id]);
    for (const r of rows) console.log(`  ${String(r.priority).padEnd(3)} ${r.sku_id.padEnd(8)} ${String(r.sku_name).slice(0, 30).padEnd(30)} ${r.action.padEnd(20)} qty=${String(r.recommended_qty).padEnd(6)} cover=${r.cover_weeks?.toFixed(2) ?? "n/a"}  ${r.recent_vs_baseline_pct >= 0 ? "+" : ""}${r.recent_vs_baseline_pct?.toFixed(1)}%  ${JSON.stringify(r.flags)}`);
    console.log("Fallbacks used:", ((await db.query("SELECT fallbacks FROM runs WHERE run_id=$1", [res.run_id]))[0].fallbacks as string[]).join(", "));
  }
  process.exit(res.status === "FAILED" ? 1 : 0);
})();
