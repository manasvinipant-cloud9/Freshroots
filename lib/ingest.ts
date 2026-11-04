// Input stage. SAP exports are loaded behind a DataSource so a live SAP connector can replace CSV later.
// Raw columns are renamed to logical names from config/schema-map.json; a missing required column fails loudly.
import fs from "node:fs";
import path from "node:path";
import { parseCsv, type Table } from "./csv";
import type { SchemaMap } from "./config";

export class SchemaError extends Error {}

export type RawData = Record<string, Table>;

export interface DataSource {
  readonly label: string;
  load(): Promise<RawData>;
}

/** Maps CSV text (keyed by file name) onto logical columns. Shared by every CSV-based source. */
export function loadFromTexts(texts: Record<string, string | undefined>, schema: SchemaMap): RawData {
  const out: RawData = {};
  for (const [key, spec] of Object.entries(schema.files)) {
    const text = texts[spec.file];
    if (text === undefined) throw new SchemaError(`Required file missing: ${spec.file}`);
    const t = parseCsv(text);
    const missing = Object.values(spec.required).filter((real) => !(real in t.columns));
    if (missing.length) {
      throw new SchemaError(`${spec.file} is missing required column(s) ${JSON.stringify(missing)} (found ${JSON.stringify(Object.keys(t.columns))})`);
    }
    const columns: Record<string, string[]> = {};
    for (const [logical, real] of Object.entries(spec.required)) columns[logical] = t.columns[real];
    for (const [logical, real] of Object.entries(spec.optional)) if (real in t.columns) columns[logical] = t.columns[real];
    out[key] = { columns, length: t.length };
  }
  return out;
}

export class FsCsvSource implements DataSource {
  constructor(private dir: string, private schema: SchemaMap, readonly label = `files in ${dir}`) {}
  async load(): Promise<RawData> {
    const texts: Record<string, string | undefined> = {};
    for (const spec of Object.values(this.schema.files)) {
      const p = path.join(this.dir, spec.file);
      texts[spec.file] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
    }
    return loadFromTexts(texts, this.schema);
  }
}

/** CSV text already in memory (uploaded exports stored in Postgres, or test fixtures). */
export class TextCsvSource implements DataSource {
  constructor(private texts: Record<string, string>, private schema: SchemaMap, readonly label = "uploaded exports") {}
  async load(): Promise<RawData> {
    return loadFromTexts(this.texts, this.schema);
  }
}
