import { ensureSchema, getDb, type Db, type Stmt } from "./db";

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
export const j = (v: unknown) => JSON.stringify(v ?? null);

/** Multi-row INSERT builder; `jsonCols` are cast to jsonb. Chunked so a statement never exceeds Postgres' parameter limit. */
export function insertStmts(table: string, cols: string[], rows: unknown[][], jsonCols: string[] = [], chunk = 150): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = part.map((r) => "(" + r.map((v, c) => { params.push(jsonCols.includes(cols[c]) ? j(v) : v ?? null); return `$${params.length}` + (jsonCols.includes(cols[c]) ? "::jsonb" : ""); }).join(",") + ")");
    out.push({ text: `INSERT INTO ${table}(${cols.join(",")}) VALUES ${tuples.join(",")}`, params });
  }
  return out;
}

export function auditStmt(actor: string, event: string, entityType = "", entityId: unknown = "", runId: number | null = null, details: unknown = {}): Stmt {
  return { text: "INSERT INTO audit_log(ts,actor,event_type,entity_type,entity_id,run_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)", params: [now(), actor, event, entityType, String(entityId), runId, j(details)] };
}

export async function audit(db: Db, actor: string, event: string, entityType = "", entityId: unknown = "", runId: number | null = null, details: unknown = {}) {
  const s = auditStmt(actor, event, entityType, entityId, runId, details);
  await db.query(s.text, s.params);
}

export async function ready(): Promise<Db> { await ensureSchema(); return getDb(); }

export const latestRun = async (db: Db, status = "SUCCESS") => (await db.query("SELECT * FROM runs WHERE status=$1 ORDER BY run_id DESC LIMIT 1", [status]))[0];
export const recommendations = (db: Db, runId: number) => db.query("SELECT * FROM recommendations WHERE run_id=$1 ORDER BY rank", [runId]);
