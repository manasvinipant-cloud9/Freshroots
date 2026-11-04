// Neon Postgres access behind a tiny interface, so tests can run the same SQL on in-memory Postgres (PGlite).
import { neon } from "@neondatabase/serverless";

export type Stmt = { text: string; params?: unknown[] };
export interface Db {
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run statements as one transaction. */
  batch(stmts: Stmt[]): Promise<void>;
}

export const dbConfigured = () => Boolean(process.env.DATABASE_URL || process.env.LOCAL_DB_DIR);

class NeonDb implements Db {
  private sql: ReturnType<typeof neon>;
  constructor(url: string) { this.sql = neon(url); }
  async query<T>(text: string, params: unknown[] = []) { return (await this.sql.query(text, params as any[])) as unknown as T[]; }
  async batch(stmts: Stmt[]) {
    if (!stmts.length) return;
    await this.sql.transaction(stmts.map((s) => this.sql.query(s.text, (s.params ?? []) as any[])));
  }
}

/** Local development without Neon: LOCAL_DB_DIR=.local-db runs the same SQL on on-disk Postgres (PGlite, a devDependency). Never set on Vercel. */
class LocalDb implements Db {
  private pg: Promise<any>;
  constructor(dir: string) {
    const mod = "@electric-sql/pglite";
    this.pg = import(/* webpackIgnore: true */ mod).then((m) => new m.PGlite(dir));
  }
  async query<T>(text: string, params: unknown[] = []) { return (await (await this.pg).query(text, params)).rows as T[]; }
  async batch(stmts: Stmt[]) {
    const pg = await this.pg;
    await pg.transaction(async (tx: any) => { for (const s of stmts) await tx.query(s.text, s.params ?? []); });
  }
}

let current: Db | null = null;
let ready: Promise<void> | null = null;

export function getDb(): Db {
  if (!current) {
    if (process.env.LOCAL_DB_DIR && !process.env.DATABASE_URL) current = new LocalDb(process.env.LOCAL_DB_DIR);
    else if (process.env.DATABASE_URL) current = new NeonDb(process.env.DATABASE_URL);
    else throw new Error("DATABASE_URL is not set");
  }
  return current;
}

/** Tests inject an in-memory database. */
export function setDb(db: Db | null) { current = db; ready = null; }

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS runs(
    run_id SERIAL PRIMARY KEY, started_at TEXT, finished_at TEXT, status TEXT, trigger TEXT, as_of TEXT, last_week TEXT,
    festival_active BOOLEAN, actor TEXT, use_ai BOOLEAN, duration_seconds DOUBLE PRECISION, n_recs INTEGER DEFAULT 0,
    n_exceptions INTEGER DEFAULT 0, sales_age_days INTEGER, inventory_age_days INTEGER, data_source TEXT, message TEXT,
    fallbacks JSONB, params JSONB)`,
  `CREATE TABLE IF NOT EXISTS data_quality_issues(
    id SERIAL PRIMARY KEY, run_id INTEGER, severity TEXT, code TEXT, count INTEGER, detail TEXT, sku_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS recommendations(
    rec_id SERIAL PRIMARY KEY, run_id INTEGER, rank INTEGER, sku_id TEXT, sku_name TEXT, category TEXT, perishable BOOLEAN,
    distributor_id TEXT, stock DOUBLE PRECISION, standard_qty DOUBLE PRECISION, baseline_avg_weekly DOUBLE PRECISION,
    recent_avg_weekly DOUBLE PRECISION, effective_avg_weekly DOUBLE PRECISION, festival_active BOOLEAN,
    cover_weeks DOUBLE PRECISION, recent_vs_baseline_pct DOUBLE PRECISION, flags JSONB, action TEXT,
    qty_multiplier DOUBLE PRECISION, recommended_qty DOUBLE PRECISION, final_qty DOUBLE PRECISION, qty_capped BOOLEAN,
    priority TEXT, value_at_risk DOUBLE PRECISION, value_unit TEXT, exception_codes JSONB, review_before_approving BOOLEAN,
    reasons JSONB, fallbacks JSONB, status TEXT DEFAULT 'PENDING', ai_status TEXT, ai_forecast JSONB, ai_confidence TEXT,
    ai_explanation TEXT, ai_unusual TEXT, ai_check TEXT, stat_forecast_weekly DOUBLE PRECISION, forecast_disagrees BOOLEAN,
    series JSONB, created_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_rec_run ON recommendations(run_id)`,
  `CREATE TABLE IF NOT EXISTS exceptions(
    id SERIAL PRIMARY KEY, run_id INTEGER, sku_id TEXT, code TEXT, blocking BOOLEAN, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS ai_calls(
    id SERIAL PRIMARY KEY, run_id INTEGER, ts TEXT, batch INTEGER, attempt INTEGER, model TEXT, prompt TEXT, response TEXT,
    status TEXT, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS decisions(
    id SERIAL PRIMARY KEY, rec_id INTEGER, run_id INTEGER, sku_id TEXT, ts TEXT, actor TEXT, decision TEXT,
    original_qty DOUBLE PRECISION, final_qty DOUBLE PRECISION, reason_code TEXT, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS po_drafts(
    id SERIAL PRIMARY KEY, po_number TEXT UNIQUE, rec_id INTEGER, run_id INTEGER, sku_id TEXT, ts TEXT, actor TEXT,
    quantity DOUBLE PRECISION, client TEXT, payload JSONB, status TEXT)`,
  `CREATE TABLE IF NOT EXISTS kill_switch_events(
    id SERIAL PRIMARY KEY, ts TEXT, actor TEXT, engaged BOOLEAN, reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS audit_log(
    id SERIAL PRIMARY KEY, ts TEXT, actor TEXT, event_type TEXT, entity_type TEXT, entity_id TEXT, run_id INTEGER, details JSONB)`,
  `CREATE TABLE IF NOT EXISTS data_files(
    name TEXT PRIMARY KEY, content TEXT, uploaded_at TEXT, actor TEXT)`,
];

export async function migrate(db: Db = getDb()) {
  for (const s of SCHEMA) await db.query(s);
}

/** Lazily creates tables once per process, like the other apps. */
export function ensureSchema(): Promise<void> {
  ready ??= migrate().catch((e) => { ready = null; throw e; });
  return ready;
}
