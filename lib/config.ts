import rulesJson from "@/config/rules.json";
import schemaMapJson from "@/config/schema-map.json";
import appJson from "@/config/app.json";

export type RulesParams = typeof rulesJson & { festival_months: number[] };
export const DEFAULT_RULES: RulesParams = rulesJson;
export const SCHEMA_MAP = schemaMapJson as SchemaMap;
export const APP = appJson;

export type FileSpec = { file: string; required: Record<string, string>; optional: Record<string, string> };
export type SchemaMap = { files: Record<string, FileSpec>; perishability_values: { perishable: string; standard: string } };

/** Config can be overridden per run (tests, experiments). Unknown keys fail loudly. */
export function rulesWith(overrides: Partial<RulesParams> = {}): RulesParams {
  const unknown = Object.keys(overrides).filter((k) => !(k in DEFAULT_RULES));
  if (unknown.length) throw new Error(`Unknown rules parameter(s): ${unknown.join(", ")}`);
  return { ...DEFAULT_RULES, ...overrides };
}
