// Orchestrates Trigger -> Input -> Processing -> Context -> AI -> Output for one run.
import { DEFAULT_RULES, SCHEMA_MAP, type RulesParams } from "./config";
import { clean, hardStops } from "./cleanup";
import { enrich, buildAiClient, emptyAi, type AiClient } from "./ai";
import type { Db } from "./db";
import { FsCsvSource, TextCsvSource, type DataSource, SchemaError } from "./ingest";
import { isEngaged } from "./killswitch";
import { evaluate } from "./rules";
import { audit, insertStmts, j, now, ready } from "./store";
import path from "node:path";

export type RunOptions = {
  asOf?: string | null; useAi?: boolean; trigger?: "manual" | "scheduled" | "dashboard" | "cli"; actor?: string;
  source?: DataSource; aiClient?: AiClient | null | "auto"; rules?: RulesParams; db?: Db;
};
export type RunResult = { run_id: number; status: "SUCCESS" | "FAILED" | "SKIPPED_KILL_SWITCH"; message: string; n_recs?: number; n_exceptions?: number };

export const defaultActor = () => process.env.DEFAULT_USER || "raghav";

/** Uploaded exports (a complete set of the five files) take priority over the bundled seed data. */
export async function defaultSource(db: Db): Promise<DataSource> {
  const rows = await db.query<{ name: string; content: string }>("SELECT name, content FROM data_files");
  const texts = Object.fromEntries(rows.map((r) => [r.name, r.content]));
  if (Object.values(SCHEMA_MAP.files).every((f) => f.file in texts)) return new TextCsvSource(texts, SCHEMA_MAP, "uploaded exports");
  return new FsCsvSource(process.env.FRESHROOTS_DATA_DIR || path.join(process.cwd(), "data"), SCHEMA_MAP, "bundled seed data");
}

/** Runs once. Data problems become visible FAILED runs, never exceptions. */
export async function runPipeline(opts: RunOptions = {}): Promise<RunResult> {
  const db = opts.db ?? (await ready());
  const actor = opts.actor ?? defaultActor();
  const useAi = opts.useAi ?? true;
  const params = opts.rules ?? DEFAULT_RULES;
  const t0 = Date.now();
  const started = (await db.query<{ run_id: number }>(
    "INSERT INTO runs(started_at,status,trigger,as_of,actor,use_ai) VALUES($1,'RUNNING',$2,$3,$4,$5) RETURNING run_id",
    [now(), opts.trigger ?? "manual", opts.asOf ?? null, actor, useAi]))[0];
  const runId = started.run_id;
  await audit(db, actor, "RUN_STARTED", "run", runId, runId, { trigger: opts.trigger ?? "manual", as_of: opts.asOf ?? null, use_ai: useAi });

  const finish = async (status: RunResult["status"], message: string, extra: Record<string, unknown> = {}): Promise<RunResult> => {
    const cols: Record<string, unknown> = { finished_at: now(), status, message, duration_seconds: Math.round((Date.now() - t0)) / 1000, ...extra };
    const keys = Object.keys(cols);
    await db.query(`UPDATE runs SET ${keys.map((k, i) => `${k}=$${i + 1}${k === "fallbacks" || k === "params" ? "::jsonb" : ""}`).join(",")} WHERE run_id=$${keys.length + 1}`,
      [...keys.map((k) => (k === "fallbacks" || k === "params" ? j(cols[k]) : cols[k])), runId]);
    await audit(db, actor, `RUN_${status}`, "run", runId, runId, { message, n_recs: extra.n_recs, n_exceptions: extra.n_exceptions });
    return { run_id: runId, status, message, n_recs: extra.n_recs as number | undefined, n_exceptions: extra.n_exceptions as number | undefined };
  };

  if (await isEngaged(db)) return finish("SKIPPED_KILL_SWITCH", "Kill switch is engaged: run skipped");

  let source: DataSource;
  let result;
  try {
    source = opts.source ?? (await defaultSource(db));
    result = clean(await source.load(), params, SCHEMA_MAP, opts.asOf);
  } catch (e) {
    if (e instanceof SchemaError) {
      await db.query("INSERT INTO data_quality_issues(run_id,severity,code,count,detail) VALUES($1,'HARD_STOP','SCHEMA_ERROR',0,$2)", [runId, e.message]);
      return finish("FAILED", `Schema error: ${e.message}`);
    }
    return finish("FAILED", `Unexpected error in cleanup: ${(e as Error).name}: ${(e as Error).message}`);
  }
  const m = result.metrics as Record<string, any>;
  await db.batch(insertStmts("data_quality_issues", ["run_id", "severity", "code", "count", "detail", "sku_id"], result.issues.map((i) => [runId, i.severity, i.code, i.count, i.detail, i.sku_id ?? null])));
  if (hardStops(result).length || !result.data) {
    return finish("FAILED", "Data-quality hard stop: " + hardStops(result).map((i) => i.code).join("; "),
      { as_of: m.as_of ?? null, sales_age_days: m.sales_age_days ?? null, inventory_age_days: m.inventory_age_days ?? null, fallbacks: result.fallbacks, data_source: source.label });
  }

  const data = result.data;
  const res = evaluate(data, params);
  const fallbacks = [...new Set([...result.fallbacks, ...res.runFallbacks])].sort();

  // ---- AI (optional, never blocks) ----
  const client = opts.aiClient === "auto" || opts.aiClient === undefined ? buildAiClient() : opts.aiClient;
  const ai = useAi ? await enrich(client, db, runId, res.recs, res.exceptions, data) : new Map(res.recs.map((r) => [r.sku_id, emptyAi(r, "SKIPPED")]));

  // ---- persist ----
  const ts = now();
  const recCols = ["run_id", "rank", "sku_id", "sku_name", "category", "perishable", "distributor_id", "stock", "standard_qty", "baseline_avg_weekly", "recent_avg_weekly", "effective_avg_weekly", "festival_active", "cover_weeks", "recent_vs_baseline_pct", "flags", "action", "qty_multiplier", "recommended_qty", "qty_capped", "priority", "value_at_risk", "value_unit", "exception_codes", "review_before_approving", "reasons", "fallbacks", "status", "ai_status", "ai_forecast", "ai_confidence", "ai_explanation", "ai_unusual", "ai_check", "stat_forecast_weekly", "forecast_disagrees", "series", "created_at", "updated_at"];
  const rows = res.recs.map((r) => {
    const a = ai.get(r.sku_id)!;
    const series = Array.from((data.series.get(r.sku_id) ?? new Float64Array()).slice(-16), (v) => (Number.isNaN(v) ? null : v));
    return [runId, r.rank, r.sku_id, r.sku_name, r.category, r.perishable, r.distributor_id, r.stock, r.standard_qty, r.baseline_avg_weekly, r.recent_avg_weekly, r.effective_avg_weekly, r.festival_active, r.cover_weeks, r.recent_vs_baseline_pct, r.flags, r.action, r.qty_multiplier, r.recommended_qty, r.qty_capped, r.priority, r.value_at_risk, r.value_unit, r.exception_codes, r.review_before_approving, r.reasons, r.fallbacks, "PENDING", a.ai_status, a.ai_forecast, a.ai_confidence, a.ai_explanation, a.ai_unusual, a.ai_check, a.stat_forecast_weekly, a.forecast_disagrees, series, ts, ts];
  });
  const acting = res.recs.filter((r) => r.action !== "NO_ACTION");
  await db.batch([
    { text: "UPDATE recommendations SET status='SUPERSEDED', updated_at=$1 WHERE status='PENDING'", params: [ts] },   // yesterday's numbers are never approvable
    ...insertStmts("recommendations", recCols, rows, ["flags", "exception_codes", "reasons", "fallbacks", "ai_forecast", "series"], 60),
    ...insertStmts("exceptions", ["run_id", "sku_id", "code", "blocking", "detail"], res.exceptions.map((e) => [runId, e.sku_id, e.code, e.blocking, e.detail])),
    ...insertStmts("audit_log", ["ts", "actor", "event_type", "entity_type", "entity_id", "run_id", "details"],
      acting.map((r) => [ts, "system", "RECOMMENDATION_CREATED", "sku", r.sku_id, runId, { action: r.action, priority: r.priority, qty: r.recommended_qty, flags: r.flags, exceptions: r.exception_codes }]), ["details"]),
  ]);
  return finish("SUCCESS", `${res.recs.length} SKUs evaluated`, {
    n_recs: res.recs.length, n_exceptions: res.exceptions.length, as_of: m.as_of, last_week: m.last_week, festival_active: data.festivalActive,
    sales_age_days: m.sales_age_days, inventory_age_days: m.inventory_age_days, fallbacks, params, data_source: source.label,
  });
}
