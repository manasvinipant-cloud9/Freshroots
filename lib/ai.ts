// AI stage: Gemini forecasts and explains around the rule outcomes (RUBRIC section 8).
// Gemini gets precomputed facts only and never changes a flag, action or quantity: its output lands in separate ai_* fields.
// Any failure degrades to rules-only with "AI note unavailable".
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { Db } from "./db";
import type { PlanningData } from "./cleanup";
import type { Exc, Rec } from "./rules";
import { APP } from "./config";
import { audit, now } from "./store";

export const SYSTEM_PROMPT = `You are an analyst assistant for Freshroots, an FMCG distributor in Maharashtra and Goa.
A deterministic rules engine has ALREADY decided each SKU's flags, action and quantity. You may NOT change, second-guess or restate them as different numbers. Your three jobs:
1. Forecast units per week for the next 4 weeks for each SKU, from the weekly series and festival flag given.
2. Write a two-sentence plain-language explanation of the recommendation for the planner, Raghav.
3. For SKUs with exceptions, say what looks unusual and what Raghav should check.
Rules: do NOT do arithmetic on stock or quantities (all numbers are precomputed and given to you); do NOT invent external events such as promotions, weather or competitor moves. A competitor scheme may be mentioned only as a clearly labelled hypothesis ("possible, unverified"). Reply with JSON only, matching the schema.`;

/** Anything with generate() works, so tests can inject a fake. Attempt 1 uses models[0]; the one retry uses models[1]. */
export interface AiClient {
  models: string[];
  generate(model: string, system: string, prompt: string): Promise<string>;
}

const noteSchema = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sku_id: { type: "string" },
          forecast_next_4_weeks: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "Units per week for each of the next 4 weeks" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          explanation: { type: "string", description: "Two plain-language sentences" },
          what_looks_unusual: { type: "string", description: "Only for SKUs with exceptions; else empty" },
          what_to_check: { type: "string", description: "Only for SKUs with exceptions; else empty" },
        },
        required: ["sku_id", "forecast_next_4_weeks", "confidence", "explanation"],
      },
    },
  },
  required: ["notes"],
};

export function buildAiClient(): AiClient | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const ai = new GoogleGenAI({ apiKey: key });
  return {
    models: [process.env.GEMINI_MODEL || "gemini-3.8-flash", process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-latest"],
    async generate(model, system, prompt) {
      const res = await ai.models.generateContent({
        model, contents: prompt,
        config: {
          systemInstruction: system, temperature: APP.ai.temperature, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          httpOptions: { timeout: APP.ai.timeout_ms }, responseMimeType: "application/json", responseJsonSchema: noteSchema,
        },
      });
      if (!res.text) throw new Error("The model returned an empty response");
      return res.text;
    },
  };
}

export type AiFields = {
  ai_status: "OK" | "UNAVAILABLE" | "SKIPPED"; ai_forecast: number[] | null; ai_confidence: string | null; ai_explanation: string | null;
  ai_unusual: string | null; ai_check: string | null; stat_forecast_weekly: number; forecast_disagrees: boolean;
};
export const statForecastWeekly = (r: Rec) => r.effective_avg_weekly ?? 0;   // trailing average, already festival-adjusted
export const emptyAi = (r: Rec, status: AiFields["ai_status"]): AiFields => ({ ai_status: status, ai_forecast: null, ai_confidence: null, ai_explanation: null, ai_unusual: null, ai_check: null, stat_forecast_weekly: statForecastWeekly(r), forecast_disagrees: false });

type Note = { sku_id: string; forecast_next_4_weeks: number[]; confidence: string; explanation: string; what_looks_unusual?: string; what_to_check?: string };

export function validate(text: string, expected: string[], seriesMax: Record<string, number>, maxMultiple: number): Record<string, Note> {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.notes)) throw new Error("response has no notes array");
  const out: Record<string, Note> = {};
  for (const n of parsed.notes as Note[]) {
    if (!n || !expected.includes(n.sku_id)) continue;
    if (!["low", "medium", "high"].includes(n.confidence)) throw new Error(`bad confidence ${JSON.stringify(n.confidence)}`);
    const f = n.forecast_next_4_weeks;
    if (!Array.isArray(f) || f.length !== 4) throw new Error(`forecast for ${n.sku_id} must have 4 numbers`);
    const cap = Math.max(seriesMax[n.sku_id] ?? 0, 1) * maxMultiple;
    if (f.some((x) => typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > cap)) throw new Error(`forecast out of range for ${n.sku_id}`);
    if (typeof n.explanation !== "string" || !n.explanation.trim()) throw new Error(`empty explanation for ${n.sku_id}`);
    out[n.sku_id] = n;
  }
  return out;
}

/** Returns AI fields keyed by SKU. Never throws, never touches rule output. */
export async function enrich(client: AiClient | null, db: Db, runId: number, recs: Rec[], exceptions: Exc[], data: PlanningData): Promise<Map<string, AiFields>> {
  const out = new Map<string, AiFields>();
  for (const r of recs) out.set(r.sku_id, emptyAi(r, "SKIPPED"));
  const wanted = recs.filter((r) => r.action !== "NO_ACTION" || r.exception_codes.length > 0);
  if (!wanted.length) return out;
  if (!client) {
    for (const r of wanted) out.set(r.sku_id, emptyAi(r, "UNAVAILABLE"));
    await audit(db, "system", "AI_UNAVAILABLE", "run", runId, runId, { reason: "no GEMINI_API_KEY" });
    return out;
  }
  const excBy = new Map<string, string[]>();
  for (const e of exceptions) excBy.set(e.sku_id, [...(excBy.get(e.sku_id) ?? []), e.detail]);
  const seriesOf = (id: string) => Array.from((data.series.get(id) ?? new Float64Array()).slice(-16), (v) => (Number.isNaN(v) ? null : v));
  const seriesMax: Record<string, number> = {};
  const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
  let okCount = 0;
  const bs = APP.ai.batch_size;
  for (let b = 0; b < wanted.length; b += bs) {
    const batch = wanted.slice(b, b + bs);
    const facts = batch.map((r) => {
      const s = seriesOf(r.sku_id);
      seriesMax[r.sku_id] = Math.max(0, ...s.filter((v): v is number => v !== null));
      return {
        sku_id: r.sku_id, name: r.sku_name, category: r.category, perishable: r.perishable, festival_month_active: r.festival_active,
        weekly_units_last_weeks: s, baseline_avg_weekly: round2(r.baseline_avg_weekly), recent_avg_weekly: round2(r.recent_avg_weekly),
        weeks_of_cover: round2(r.cover_weeks), recent_vs_baseline_pct: round2(r.recent_vs_baseline_pct), stock_units: r.stock,
        rule_flags: r.flags, rule_action: r.action, rule_quantity: r.recommended_qty, exceptions: excBy.get(r.sku_id) ?? [],
      };
    });
    const expected = facts.map((f) => f.sku_id);
    const prompt = `Return JSON {"notes": [...]} with one entry per SKU below.\nFACTS:\n${JSON.stringify(facts)}`;
    let notes: Record<string, Note> = {};
    for (let attempt = 1; attempt <= 2; attempt++) {              // one retry, on the fallback model
      const model = client.models[Math.min(attempt - 1, client.models.length - 1)];
      let text: string | null = null, status = "OK", error: string | null = null;
      try {
        text = await client.generate(model, SYSTEM_PROMPT, prompt);
        notes = validate(text, expected, seriesMax, APP.ai.max_forecast_multiple);
        if (!Object.keys(notes).length) throw new Error("no usable notes in response");
      } catch (e) {
        notes = {};
        const err = e as Error;
        status = err instanceof SyntaxError || /response has no|bad confidence|forecast|explanation|no usable/.test(err.message) ? "INVALID" : "ERROR";
        error = `${err.name}: ${err.message}`;
      }
      await db.query("INSERT INTO ai_calls(run_id,ts,batch,attempt,model,prompt,response,status,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [runId, now(), Math.floor(b / bs) + 1, attempt, model, prompt, text, status, error]);
      if (status === "OK") break;
    }
    for (const r of batch) {
      const n = notes[r.sku_id];
      if (!n) { out.set(r.sku_id, emptyAi(r, "UNAVAILABLE")); continue; }
      okCount++;
      const fc = n.forecast_next_4_weeks.map((x) => Math.round(x * 10) / 10);
      const stat = statForecastWeekly(r) * 4;
      const diff = (Math.abs(fc.reduce((a, c) => a + c, 0) - stat) / Math.max(stat, 1)) * 100;
      out.set(r.sku_id, {
        ai_status: "OK", ai_forecast: fc, ai_confidence: n.confidence, ai_explanation: n.explanation,
        ai_unusual: n.what_looks_unusual || null, ai_check: n.what_to_check || null,
        stat_forecast_weekly: statForecastWeekly(r), forecast_disagrees: diff > APP.ai.forecast_disagree_pct,
      });
    }
  }
  await audit(db, "system", "AI_ENRICHED", "run", runId, runId, { ok: okCount, requested: wanted.length });
  return out;
}
