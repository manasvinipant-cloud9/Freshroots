// Read-side queries for the dashboard pages.
import type { Db } from "./db";

export type RecRow = {
  rec_id: number; run_id: number; rank: number; sku_id: string; sku_name: string; category: string; perishable: boolean; distributor_id: string;
  stock: number | null; standard_qty: number | null; baseline_avg_weekly: number | null; recent_avg_weekly: number | null; effective_avg_weekly: number | null;
  festival_active: boolean; cover_weeks: number | null; recent_vs_baseline_pct: number | null; flags: string[]; action: string; qty_multiplier: number | null;
  recommended_qty: number; final_qty: number | null; qty_capped: boolean; priority: string; value_at_risk: number; value_unit: string;
  exception_codes: string[]; review_before_approving: boolean; reasons: Record<string, unknown>[]; fallbacks: string[]; status: string;
  ai_status: string; ai_forecast: number[] | null; ai_confidence: string | null; ai_explanation: string | null; ai_unusual: string | null; ai_check: string | null;
  stat_forecast_weekly: number | null; forecast_disagrees: boolean; series: (number | null)[]; updated_at: string;
};
export type ExcRow = { sku_id: string; code: string; blocking: boolean; detail: string };
export type RunRow = {
  run_id: number; started_at: string; finished_at: string | null; status: string; trigger: string; as_of: string | null; last_week: string | null;
  festival_active: boolean | null; actor: string; use_ai: boolean; duration_seconds: number | null; n_recs: number; n_exceptions: number;
  sales_age_days: number | null; inventory_age_days: number | null; data_source: string | null; message: string | null; fallbacks: string[] | null;
};

export const runs = (db: Db, limit = 50) => db.query<RunRow>("SELECT * FROM runs ORDER BY run_id DESC LIMIT $1", [limit]);
export const latestSuccess = async (db: Db) => (await db.query<RunRow>("SELECT * FROM runs WHERE status='SUCCESS' ORDER BY run_id DESC LIMIT 1"))[0];
export const runRecs = (db: Db, runId: number) => db.query<RecRow>("SELECT * FROM recommendations WHERE run_id=$1 ORDER BY rank", [runId]);
export const runExceptions = (db: Db, runId: number) => db.query<ExcRow>("SELECT sku_id, code, blocking, detail FROM exceptions WHERE run_id=$1 ORDER BY sku_id", [runId]);
export const dqIssues = (db: Db, runId: number) => db.query("SELECT severity, code, count, detail, sku_id FROM data_quality_issues WHERE run_id=$1 ORDER BY CASE severity WHEN 'HARD_STOP' THEN 0 WHEN 'SOFT_FIX' THEN 1 WHEN 'FALLBACK' THEN 2 ELSE 3 END, id", [runId]);
export const aiCalls = (db: Db, runId: number) => db.query("SELECT ts, batch, attempt, model, status, error FROM ai_calls WHERE run_id=$1 ORDER BY id", [runId]);
export const auditLog = (db: Db, limit = 100) => db.query("SELECT ts, actor, event_type, entity_type, entity_id, run_id, details FROM audit_log ORDER BY id DESC LIMIT $1", [limit]);
export const poDrafts = (db: Db) => db.query("SELECT po_number, sku_id, quantity, client, status, ts, actor, payload FROM po_drafts ORDER BY id DESC");
export const statusCounts = (db: Db) => db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM recommendations WHERE action NOT IN ('NO_ACTION') GROUP BY status");
export const lifecycle = (db: Db) => db.query("SELECT rec_id, run_id, sku_id, sku_name, action, recommended_qty, final_qty, status, updated_at FROM recommendations WHERE action NOT IN ('NO_ACTION','EXCEPTION') ORDER BY rec_id DESC LIMIT 300");
export const approvedWithoutPo = async (db: Db) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM recommendations WHERE status='APPROVED' AND action IN ('REORDER_NOW','REORDER_HIGH_DEMAND')"))[0].n;
export const decisionStats = (db: Db) => db.query<{ decision: string; reason_code: string | null; n: number }>("SELECT decision, reason_code, count(*)::int AS n FROM decisions GROUP BY decision, reason_code");
export const uploadedFiles = (db: Db) => db.query<{ name: string; uploaded_at: string; actor: string; bytes: number }>("SELECT name, uploaded_at, actor, length(content)::int AS bytes FROM data_files ORDER BY name");
