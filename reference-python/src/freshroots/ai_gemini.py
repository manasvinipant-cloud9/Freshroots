"""AI stage: Gemini forecasts and explains around the rule outcomes (RUBRIC section 8).

Gemini receives precomputed facts only and never changes a flag, action or quantity:
its output is merged into separate ai_* columns. Any failure degrades to rules-only.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field, ValidationError

from freshroots.cleanup import PlanningData
from freshroots.store import Store, now

SYSTEM_PROMPT = """You are an analyst assistant for Freshroots, an FMCG distributor in Maharashtra and Goa.
A deterministic rules engine has ALREADY decided each SKU's flags, action and quantity. You may NOT change,
second-guess or restate them as different numbers. Your three jobs:
1. Forecast units per week for the next 4 weeks for each SKU, from the weekly series and festival flag given.
2. Write a two-sentence plain-language explanation of the recommendation for the planner, Raghav.
3. For SKUs with exceptions, say what looks unusual and what Raghav should check.
Rules: do NOT do arithmetic on stock or quantities (all numbers are precomputed and given to you); do NOT invent
external events such as promotions, weather or competitor moves. A competitor scheme may be mentioned only as a
clearly labelled hypothesis ("possible, unverified"). Reply with JSON only, matching the schema."""

CONFIDENCE = ("low", "medium", "high")


class SkuNote(BaseModel):
    sku_id: str
    forecast_next_4_weeks: List[float] = Field(min_length=4, max_length=4)
    confidence: str
    explanation: str
    what_looks_unusual: Optional[str] = None
    what_to_check: Optional[str] = None


class BatchResponse(BaseModel):
    notes: List[SkuNote]


class GeminiClient:
    """Thin wrapper over the Google Gen AI SDK. Tests substitute any object with .generate()."""

    def __init__(self, model: str, temperature: float, timeout_seconds: int, api_key: Optional[str] = None):
        from google import genai
        from google.genai import types
        self._types = types
        self.model = model
        self.temperature = temperature
        self.client = genai.Client(api_key=api_key or os.environ["GEMINI_API_KEY"],
                                   http_options=types.HttpOptions(timeout=timeout_seconds * 1000))

    def generate(self, system: str, prompt: str) -> str:
        t = self._types
        resp = self.client.models.generate_content(
            model=self.model, contents=prompt,
            config=t.GenerateContentConfig(system_instruction=system, temperature=self.temperature,
                                           response_mime_type="application/json", response_schema=BatchResponse))
        return resp.text


def build_client(ai_cfg: Dict[str, Any]) -> Optional[GeminiClient]:
    if not os.environ.get("GEMINI_API_KEY"):
        return None
    model = os.environ.get("GEMINI_MODEL") or ai_cfg["model"]
    return GeminiClient(model, ai_cfg["temperature"], ai_cfg["timeout_seconds"])


def stat_forecast_weekly(row) -> float:
    """Simple statistical baseline: trailing average, already festival-adjusted (effective average)."""
    v = row["effective_avg_weekly"]
    return 0.0 if pd.isna(v) else float(v)


def _facts(row, series: List[float], exc_details: List[str]) -> Dict[str, Any]:
    f = lambda v: None if pd.isna(v) else round(float(v), 2)
    return {
        "sku_id": row["sku_id"], "name": row["sku_name"], "category": row["category"],
        "perishable": bool(row["perishable"]), "festival_month_active": bool(row["festival_active"]),
        "weekly_units_last_weeks": series,
        "baseline_avg_weekly": f(row["baseline_avg_weekly"]), "recent_avg_weekly": f(row["recent_avg_weekly"]),
        "weeks_of_cover": f(row["cover_weeks"]), "recent_vs_baseline_pct": f(row["recent_vs_baseline_pct"]),
        "stock_units": f(row["stock"]),
        "rule_flags": list(row["flags"]), "rule_action": row["action"], "rule_quantity": f(row["recommended_qty"]),
        "exceptions": exc_details,
    }


def _validate(resp_text: str, expected: List[str], series_max: Dict[str, float], max_multiple: float) -> Dict[str, SkuNote]:
    parsed = BatchResponse.model_validate(json.loads(resp_text))
    out: Dict[str, SkuNote] = {}
    for n in parsed.notes:
        if n.sku_id not in expected:
            continue
        if n.confidence not in CONFIDENCE:
            raise ValueError("bad confidence %r" % n.confidence)
        cap = max(series_max.get(n.sku_id, 0.0), 1.0) * max_multiple
        if any((not np.isfinite(x)) or x < 0 or x > cap for x in n.forecast_next_4_weeks):
            raise ValueError("forecast out of range for %s" % n.sku_id)
        if not n.explanation.strip():
            raise ValueError("empty explanation for %s" % n.sku_id)
        out[n.sku_id] = n
    return out


def enrich(client, store: Store, run_id: int, recs: pd.DataFrame, exceptions: pd.DataFrame,
           data: PlanningData, ai_cfg: Dict[str, Any], model: str = "") -> pd.DataFrame:
    """Add ai_* columns to recs. Never touches rule columns. Never raises."""
    recs = recs.copy()
    n = len(recs)
    recs["ai_status"] = "SKIPPED"
    recs["ai_forecast"] = [None] * n
    recs["ai_confidence"] = None
    recs["ai_explanation"] = None
    recs["ai_unusual"] = None
    recs["ai_check"] = None
    recs["stat_forecast_weekly"] = recs.apply(stat_forecast_weekly, axis=1)
    recs["forecast_disagrees"] = False

    wanted = recs[(recs["action"] != "NO_ACTION") | recs["exception_codes"].map(len).gt(0)]
    if wanted.empty:
        return recs
    if client is None:
        recs.loc[wanted.index, "ai_status"] = "UNAVAILABLE"
        store.audit("system", "AI_UNAVAILABLE", "run", run_id, run_id, {"reason": "no GEMINI_API_KEY"})
        return recs

    exc_by = exceptions.groupby("sku_id")["detail"].apply(list).to_dict() if len(exceptions) else {}
    weekly = data.weekly
    series = {s: [None if np.isnan(v) else float(v) for v in weekly.loc[s].to_numpy()[-16:]] for s in wanted["sku_id"]}
    series_max = {s: max([v for v in vals if v is not None] or [0.0]) for s, vals in series.items()}
    bs = int(ai_cfg["batch_size"])
    idx = list(wanted.index)
    ok_count = 0
    for b in range(0, len(idx), bs):
        batch_idx = idx[b:b + bs]
        facts = [_facts(recs.loc[i], series[recs.loc[i, "sku_id"]], exc_by.get(recs.loc[i, "sku_id"], []))
                 for i in batch_idx]
        expected = [f["sku_id"] for f in facts]
        prompt = "Return JSON {\"notes\": [...]} with one entry per SKU below.\nFACTS:\n" + json.dumps(facts)
        notes: Dict[str, SkuNote] = {}
        for attempt in (1, 2):   # one retry
            text, err, status = None, None, "OK"
            try:
                text = client.generate(SYSTEM_PROMPT, prompt)
                notes = _validate(text, expected, series_max, float(ai_cfg["max_forecast_multiple"]))
                if not notes:
                    raise ValueError("no usable notes in response")
            except (ValidationError, ValueError, json.JSONDecodeError) as e:
                status, err = "INVALID", "%s: %s" % (type(e).__name__, e)
            except Exception as e:  # network, quota, SDK error
                status, err = "ERROR", "%s: %s" % (type(e).__name__, e)
            store.execute("INSERT INTO ai_calls(run_id,ts,batch,attempt,model,prompt,response,status,error)"
                          " VALUES(?,?,?,?,?,?,?,?,?)",
                          (run_id, now(), b // bs + 1, attempt, model, prompt, text, status, err))
            if status == "OK":
                break
            notes = {}
        for i in batch_idx:
            sid = recs.loc[i, "sku_id"]
            note = notes.get(sid)
            if note is None:
                recs.loc[i, "ai_status"] = "UNAVAILABLE"
                continue
            ok_count += 1
            fc = [round(float(x), 1) for x in note.forecast_next_4_weeks]
            stat = recs.loc[i, "stat_forecast_weekly"] * 4
            diff = abs(sum(fc) - stat) / max(stat, 1.0) * 100.0
            recs.at[i, "ai_forecast"] = fc
            recs.loc[i, ["ai_status", "ai_confidence", "ai_explanation", "ai_unusual", "ai_check"]] = [
                "OK", note.confidence, note.explanation, note.what_looks_unusual, note.what_to_check]
            recs.loc[i, "forecast_disagrees"] = bool(diff > float(ai_cfg["forecast_disagree_pct"]))
    store.audit("system", "AI_ENRICHED", "run", run_id, run_id, {"ok": ok_count, "requested": len(wanted)})
    return recs
