"""Orchestrates Trigger -> Input -> Processing -> Context -> AI -> Output for one run."""
from __future__ import annotations

import json
import os
import time
from datetime import date
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd

from freshroots import ai_gemini, killswitch
from freshroots.cleanup import clean
from freshroots.config import Config
from freshroots.ingest import CsvDataSource, DataSource, SchemaError
from freshroots.rules import evaluate
from freshroots.store import Store, now


def default_user() -> str:
    return os.environ.get("FRESHROOTS_USER", "raghav")


def _py(v):
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return None if pd.isna(v) else float(v)
    return v


def run_pipeline(cfg: Config, store: Optional[Store] = None, as_of: Optional[date] = None, use_ai: bool = True,
                 trigger: str = "manual", user: Optional[str] = None, source: Optional[DataSource] = None,
                 ai_client: Any = "auto") -> Dict[str, Any]:
    """Run once. Returns {'run_id', 'status', ...}. Never raises for data problems: they become FAILED runs."""
    store = store or Store(cfg.db_path)
    user = user or default_user()
    t0 = time.time()
    run_id = store.execute(
        "INSERT INTO runs(started_at,status,trigger,as_of,user,use_ai) VALUES(?,?,?,?,?,?)",
        (now(), "RUNNING", trigger, str(as_of) if as_of else None, user, int(use_ai)))
    store.audit(user, "RUN_STARTED", "run", run_id, run_id, {"trigger": trigger, "as_of": str(as_of), "use_ai": use_ai})

    def finish(status, message="", **extra):
        cols = {"finished_at": now(), "status": status, "message": message,
                "duration_seconds": round(time.time() - t0, 2)}
        cols.update(extra)
        store.execute("UPDATE runs SET %s WHERE run_id=?" % ",".join("%s=?" % k for k in cols),
                      list(cols.values()) + [run_id])
        store.audit(user, "RUN_" + status, "run", run_id, run_id, {"message": message, **{k: v for k, v in extra.items() if k in ("n_recs", "n_exceptions")}})
        return {"run_id": run_id, "status": status, "message": message, **extra}

    if killswitch.is_engaged(store):
        return finish("SKIPPED_KILL_SWITCH", "Kill switch is engaged: run skipped")

    try:
        raw = (source or CsvDataSource(cfg.data_dir, cfg.schema_map)).load()
        result = clean(raw, cfg.rules, cfg.schema_map, as_of)
    except SchemaError as e:
        store.execute("INSERT INTO data_quality_issues(run_id,severity,code,count,detail) VALUES(?,?,?,?,?)",
                      (run_id, "HARD_STOP", "SCHEMA_ERROR", 0, str(e)))
        return finish("FAILED", "Schema error: %s" % e)
    except Exception as e:  # unexpected: still a visible FAILED run
        return finish("FAILED", "Unexpected error in cleanup: %s: %s" % (type(e).__name__, e))

    with store.conn() as c:
        c.executemany("INSERT INTO data_quality_issues(run_id,severity,code,count,detail,sku_id) VALUES(?,?,?,?,?,?)",
                      [(run_id, i.severity, i.code, i.count, i.detail, i.sku_id) for i in result.issues])
    m = result.metrics
    if not result.ok:
        return finish("FAILED", "Data-quality hard stop: " + "; ".join(i.code for i in result.hard_stops),
                      as_of=m.get("as_of"), sales_age_days=m.get("sales_age_days"),
                      inventory_age_days=m.get("inventory_age_days"),
                      fallbacks=json.dumps(result.fallbacks))

    data = result.data
    res = evaluate(data, cfg.rules)
    recs, exc = res.recs, res.exceptions
    fallbacks = sorted(set(result.fallbacks) | set(res.run_fallbacks))

    # ---- AI (optional, never blocks) --------------------------------------------
    model = os.environ.get("GEMINI_MODEL") or cfg.app["ai"]["model"]
    if use_ai:
        client = ai_gemini.build_client(cfg.app["ai"]) if ai_client == "auto" else ai_client
        recs = ai_gemini.enrich(client, store, run_id, recs, exc, data, cfg.app["ai"], model)
    else:
        recs = recs.assign(ai_status="SKIPPED", ai_forecast=None, ai_confidence=None, ai_explanation=None,
                           ai_unusual=None, ai_check=None, forecast_disagrees=False,
                           stat_forecast_weekly=recs["effective_avg_weekly"].fillna(0.0))

    # ---- persist -------------------------------------------------------------------
    ts = now()
    rows = []
    for r in recs.to_dict("records"):
        sid = r["sku_id"]
        series = [None if np.isnan(v) else float(v) for v in data.weekly.loc[sid].to_numpy()[-16:]]
        rows.append((
            run_id, int(r["rank"]), sid, r["sku_name"], r["category"], int(r["perishable"]), r["distributor_id"],
            _py(r["stock"]), _py(r["standard_qty"]), _py(r["baseline_avg_weekly"]), _py(r["recent_avg_weekly"]),
            _py(r["effective_avg_weekly"]), int(r["festival_active"]), _py(r["cover_weeks"]),
            _py(r["recent_vs_baseline_pct"]), json.dumps(r["flags"]), r["action"], _py(r["qty_multiplier"]),
            _py(r["recommended_qty"]), None, int(r["qty_capped"]), r["priority"], _py(r["value_at_risk"]),
            r["value_unit"], json.dumps(r["exception_codes"]), int(r["review_before_approving"]),
            json.dumps(r["reasons"], default=_py), json.dumps(r["fallbacks"]), "PENDING", r["ai_status"],
            json.dumps(r["ai_forecast"]) if isinstance(r["ai_forecast"], list) else None, r["ai_confidence"],
            r["ai_explanation"], r["ai_unusual"], r["ai_check"], _py(r["stat_forecast_weekly"]),
            int(bool(r["forecast_disagrees"])), json.dumps(series), ts, ts))
    with store.conn() as c:
        c.execute("UPDATE recommendations SET status='SUPERSEDED', updated_at=? WHERE status='PENDING'", (ts,))
        c.executemany("INSERT INTO recommendations(run_id,rank,sku_id,sku_name,category,perishable,distributor_id,stock,"
                      "standard_qty,baseline_avg_weekly,recent_avg_weekly,effective_avg_weekly,festival_active,cover_weeks,"
                      "recent_vs_baseline_pct,flags,action,qty_multiplier,recommended_qty,final_qty,qty_capped,priority,"
                      "value_at_risk,value_unit,exception_codes,review_before_approving,reasons,fallbacks,status,ai_status,"
                      "ai_forecast,ai_confidence,ai_explanation,ai_unusual,ai_check,stat_forecast_weekly,forecast_disagrees,"
                      "series,created_at,updated_at) VALUES(%s)" % ",".join("?" * 40), rows)
        c.executemany("INSERT INTO exceptions(run_id,sku_id,code,blocking,detail) VALUES(?,?,?,?,?)",
                      [(run_id, e["sku_id"], e["code"], int(e["blocking"]), e["detail"]) for e in exc.to_dict("records")])
        acting = recs[recs["action"] != "NO_ACTION"]
        c.executemany("INSERT INTO audit_log(ts,user,event_type,entity_type,entity_id,run_id,details) VALUES(?,?,?,?,?,?,?)",
                      [(ts, "system", "RECOMMENDATION_CREATED", "sku", r["sku_id"], run_id,
                        json.dumps({"action": r["action"], "priority": r["priority"], "qty": _py(r["recommended_qty"]),
                                    "flags": r["flags"], "exceptions": r["exception_codes"]}, default=_py))
                       for r in acting.to_dict("records")])
    return finish("SUCCESS", "%d SKUs evaluated" % len(recs), n_recs=len(recs), n_exceptions=len(exc),
                  as_of=m.get("as_of"), last_week=m.get("last_week"), festival_active=int(data.festival_active),
                  sales_age_days=m.get("sales_age_days"), inventory_age_days=m.get("inventory_age_days"),
                  fallbacks=json.dumps(fallbacks), params=json.dumps(cfg.rules.__dict__, default=list))
