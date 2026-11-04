import fs from "node:fs";
import path from "node:path";
import { addDays } from "@/lib/dates";
import type { PlanningData, SkuRow, DistTable } from "@/lib/cleanup";
import { DEFAULT_RULES, SCHEMA_MAP } from "@/lib/config";
import { loadFromTexts, type RawData } from "@/lib/ingest";

export type Row = { sku_id: string; baseline: number; recent?: number; stock: number | null; perishable?: boolean; std?: number | null; history?: number; filled?: number };

/** 12-week mean equals `baseline`, last 4 weeks equal `recent`, so RUBRIC section 10 reads exactly as written. */
export function makeData(rows: Row[], opts: { festival?: boolean; weeks?: number; dist?: DistTable | null } = {}): PlanningData {
  const weeks = opts.weeks ?? 16;
  const last = "2026-10-12";
  const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(last, -7 * (weeks - 1 - i)));
  const series = new Map<string, Float64Array>();
  const sku: SkuRow[] = rows.map((r) => {
    const b = r.baseline, rc = r.recent ?? r.baseline;
    const older = (12 * b - 4 * rc) / 8;
    let vals = [...Array(weeks - 12).fill(b), ...Array(8).fill(older), ...Array(4).fill(rc)] as number[];
    if (r.history !== undefined) vals = vals.map((v, i) => (i < weeks - r.history! ? NaN : v));
    series.set(r.sku_id, Float64Array.from(vals));
    return {
      sku_id: r.sku_id, sku_name: "Test " + r.sku_id, category: "Test", distributor_id: "DIST001", perishable: r.perishable ?? false,
      standard_qty: r.std === undefined ? 300 : r.std, stock: r.stock, on_order: null, unit_price: null, filled_weeks: r.filled ?? 0,
    };
  });
  return { sku, weekStarts, series, festivalActive: opts.festival ?? false, asOf: addDays(last, 7), lastWeekStart: last, distWeekly: opts.dist ?? null, filledWeeks: {} };
}

export const rawSeed = (): RawData => {
  const texts: Record<string, string> = {};
  for (const spec of Object.values(SCHEMA_MAP.files)) texts[spec.file] = fs.readFileSync(path.join(process.cwd(), "data", spec.file), "utf8");
  return loadFromTexts(texts, SCHEMA_MAP);
};
export const seedTexts = () => {
  const texts: Record<string, string> = {};
  for (const spec of Object.values(SCHEMA_MAP.files)) texts[spec.file] = fs.readFileSync(path.join(process.cwd(), "data", spec.file), "utf8");
  return texts;
};
export const P = DEFAULT_RULES;

import { PGlite } from "@electric-sql/pglite";
import { migrate, setDb, type Db } from "@/lib/db";

/** In-memory Postgres running the same SQL as Neon. */
export async function memDb(): Promise<Db> {
  const pg = new PGlite();
  const db: Db = {
    query: async (t, p) => (await pg.query(t, p as any[])).rows as any[],
    batch: async (stmts) => { await pg.transaction(async (tx) => { for (const s of stmts) await tx.query(s.text, (s.params ?? []) as any[]); }); },
  };
  await migrate(db);
  setDb(db);
  return db;
}
