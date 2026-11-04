"""End-to-end: golden table (RUBRIC 10b), kill switch, decisions, PO drafts, audit, Gemini fallback."""
import json
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from freshroots import ai_gemini, decisions, killswitch, po
from freshroots.config import load_config
from freshroots.pipeline import run_pipeline
from freshroots.store import Store

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def store(cfg):
    return Store(cfg.db_path)


def recs_of(store, run_id):
    return {r["sku_id"]: r for r in store.recommendations(run_id)}


def test_golden_seed_results_no_ai(cfg, store):
    res = run_pipeline(cfg, store, use_ai=False)
    assert res["status"] == "SUCCESS"
    r = recs_of(store, res["run_id"])
    golden = {  # sku: (cover, pct, action, qty, flags)
        "SKU001": (3.35, 21.4, "REORDER_NOW", 750, ["HIGH_DEMAND", "STOCKOUT_RISK"]),
        "SKU003": (4.36, 0.2, "REORDER_NOW", 300, ["STOCKOUT_RISK"]),
        "SKU004": (1.80, 1.5, "REORDER_NOW", 150, ["STOCKOUT_RISK"]),
        "SKU011": (1.80, 2.4, "REORDER_NOW", 500, ["STOCKOUT_RISK"]),
        "SKU013": (3.17, -1.5, "REORDER_NOW", 120, ["STOCKOUT_RISK"]),
        "SKU006": (22.23, 1.7, "PAUSE_ORDER", 0, ["OVERSTOCK_RISK"]),
        "SKU007": (4.08, 9.9, "PAUSE_ORDER", 0, ["OVERSTOCK_RISK"]),
    }
    for sku, (cover, pct, action, qty, flags) in golden.items():
        x = r[sku]
        assert round(x["cover_weeks"], 2) == cover, sku
        assert round(x["recent_vs_baseline_pct"], 1) == pct, sku
        assert x["action"] == action and x["recommended_qty"] == qty, sku
        assert json.loads(x["flags"]) == flags, sku
    assert r["SKU001"]["priority"] == "P1"
    quiet = ["SKU002", "SKU005", "SKU008", "SKU009", "SKU010", "SKU012", "SKU014", "SKU015"]
    for sku in quiet:
        assert r[sku]["action"] == "NO_ACTION", sku
        assert 6.77 <= round(r[sku]["cover_weeks"], 2) <= 11.46 and abs(r[sku]["recent_vs_baseline_pct"]) <= 10
    assert store.query("select count(*) n from exceptions")[0]["n"] == 0     # seed triggers no exception code
    run = store.one("select * from runs")
    assert run["last_week"] == "2026-W42" and run["festival_active"] == 1 and run["as_of"] == "2026-10-19"


def test_festival_uplift_changes_exactly_one_outcome_on_seed(cfg, store, tmp_path):
    """SKU002 is PAUSE_ORDER without the uplift (14.3 weeks) and NO_ACTION with it (11.5): the only change."""
    with_up = recs_of(store, run_pipeline(cfg, store, use_ai=False)["run_id"])
    cfg0 = load_config(db_path=str(tmp_path / "n.db"), rules_overrides={"festival_uplift_pct": 0})
    s0 = Store(cfg0.db_path)
    no_up = recs_of(s0, run_pipeline(cfg0, s0, use_ai=False)["run_id"])
    assert with_up["SKU002"]["action"] == "NO_ACTION" and round(with_up["SKU002"]["cover_weeks"], 1) == 11.5
    assert no_up["SKU002"]["action"] == "PAUSE_ORDER" and round(no_up["SKU002"]["cover_weeks"], 1) == 14.3
    changed = [k for k in with_up if with_up[k]["action"] != no_up[k]["action"]]
    assert changed == ["SKU002"]


def test_asof_replay_in_non_festival_month_turns_festival_off(cfg, store):
    rid = run_pipeline(cfg, store, use_ai=False, as_of=date(2026, 9, 14))["run_id"]
    run = store.one("select * from runs where run_id=?", (rid,))
    assert run["status"] == "SUCCESS" and run["festival_active"] == 0 and run["last_week"] == "2026-W37"


def test_toggle_on_seed_suppresses_high_demand(tmp_path):
    cfg = load_config(db_path=str(tmp_path / "x.db"), rules_overrides={"festival_uplift_applies_to_r1_baseline": True})
    s = Store(cfg.db_path)
    rid = run_pipeline(cfg, s, use_ai=False)["run_id"]
    x = recs_of(s, rid)["SKU001"]
    assert round(x["recent_vs_baseline_pct"], 1) == -2.8 and "HIGH_DEMAND" not in json.loads(x["flags"])
    assert x["recommended_qty"] == 500


def test_hard_stop_gives_failed_run_and_no_recommendations(cfg, store):
    res = run_pipeline(cfg, store, use_ai=False, as_of=date(2026, 12, 1))
    assert res["status"] == "FAILED"
    assert store.query("select count(*) n from recommendations")[0]["n"] == 0
    assert store.query("select count(*) n from data_quality_issues where severity='HARD_STOP'")[0]["n"] >= 1
    assert store.one("select status from runs")["status"] == "FAILED"


def test_schema_error_gives_failed_run(cfg, store, tmp_path):
    import shutil
    d = tmp_path / "bad"
    shutil.copytree(cfg.data_dir, d)
    pd.read_csv(d / "current_inventory.csv").drop(columns=["Units_On_Hand"]).to_csv(d / "current_inventory.csv", index=False)
    cfg.data_dir = d
    res = run_pipeline(cfg, store, use_ai=False)
    assert res["status"] == "FAILED" and "Units_On_Hand" in res["message"]
    assert store.query("select count(*) n from recommendations")[0]["n"] == 0


# ------------------------------------------------------------------- kill switch
def test_kill_switch_blocks_scheduled_run_and_persists(cfg, store):
    killswitch.set_engaged(store, True, "raghav", "demo")
    assert killswitch.is_engaged(Store(cfg.db_path))                          # new connection = "restart"
    res = run_pipeline(cfg, store, use_ai=False, trigger="scheduled", user="scheduler")
    assert res["status"] == "SKIPPED_KILL_SWITCH"
    assert store.query("select count(*) n from recommendations")[0]["n"] == 0
    killswitch.set_engaged(store, False, "raghav")
    assert run_pipeline(cfg, store, use_ai=False)["status"] == "SUCCESS"


def test_kill_switch_blocks_po_creation(cfg, store):
    rid = run_pipeline(cfg, store, use_ai=False)["run_id"]
    sku1 = recs_of(store, rid)["SKU001"]["rec_id"]
    client = po.DryRunZohoClient(cfg.po_drafts_dir)
    killswitch.set_engaged(store, True, "raghav")
    assert decisions.approve(store, [sku1], "raghav", client) == [None]       # approval recorded, no PO
    assert store.one("select status from recommendations where rec_id=?", (sku1,))["status"] == "APPROVED"
    assert store.query("select count(*) n from po_drafts")[0]["n"] == 0
    with pytest.raises(killswitch.KillSwitchEngaged):
        po.create_po_draft(store, sku1, client, "raghav")
    with pytest.raises(killswitch.KillSwitchEngaged):
        decisions.create_pending_po_drafts(store, "raghav", client)
    killswitch.set_engaged(store, False, "raghav")
    assert len(decisions.create_pending_po_drafts(store, "raghav", client)) == 1
    assert not list(cfg.po_drafts_dir.glob("*.json")) == []


# ------------------------------------------------------------- decisions and POs
def test_approve_creates_po_draft_json_and_audit(cfg, store):
    rid = run_pipeline(cfg, store, use_ai=False)["run_id"]
    r = recs_of(store, rid)
    client = po.DryRunZohoClient(cfg.po_drafts_dir)
    out = decisions.approve(store, [r["SKU001"]["rec_id"]], "raghav", client)
    assert out[0].startswith("FR-PO-")
    f = cfg.po_drafts_dir / (out[0] + ".json")
    payload = json.loads(f.read_text())
    assert payload["status"] == "draft" and payload["line_items"][0]["quantity"] == 750
    assert payload["line_items"][0]["sku"] == "SKU001"
    assert store.one("select status from recommendations where rec_id=?", (r["SKU001"]["rec_id"],))["status"] == "PO_DRAFTED"
    ev = {e["event_type"] for e in store.query("select event_type from audit_log")}
    assert {"RUN_STARTED", "RUN_SUCCESS", "RECOMMENDATION_CREATED", "APPROVE", "PO_DRAFTED"} <= ev


def test_nothing_becomes_po_without_approve(cfg, store):
    rid = run_pipeline(cfg, store, use_ai=False)["run_id"]
    assert store.query("select count(*) n from po_drafts")[0]["n"] == 0
    rec = recs_of(store, rid)["SKU001"]["rec_id"]
    with pytest.raises(ValueError):
        po.create_po_draft(store, rec, po.DryRunZohoClient(cfg.po_drafts_dir), "x")     # still PENDING


def test_pause_approval_needs_no_po(cfg, store):
    rid = run_pipeline(cfg, store, use_ai=False)["run_id"]
    rec = recs_of(store, rid)["SKU006"]["rec_id"]
    assert decisions.approve(store, [rec], "raghav", po.DryRunZohoClient(cfg.po_drafts_dir)) == [None]
    assert store.query("select count(*) n from po_drafts")[0]["n"] == 0


def test_reject_and_edit_require_reason_and_are_queryable(cfg, store):
    rid = run_pipeline(cfg, store, use_ai=False)["run_id"]
    r = recs_of(store, rid)
    with pytest.raises(decisions.DecisionError):
        decisions.reject(store, [r["SKU003"]["rec_id"]], "raghav", "")
    with pytest.raises(decisions.DecisionError):
        decisions.edit_quantity(store, r["SKU004"]["rec_id"], 100, "raghav", "bogus")
    decisions.reject(store, [r["SKU003"]["rec_id"]], "raghav", "supplier_issue", "supplier on strike")
    decisions.edit_quantity(store, r["SKU004"]["rec_id"], 100, "raghav", "market_knowledge")
    client = po.DryRunZohoClient(cfg.po_drafts_dir)
    po_no = decisions.approve(store, [r["SKU004"]["rec_id"]], "raghav", client)[0]
    assert json.loads((cfg.po_drafts_dir / (po_no + ".json")).read_text())["line_items"][0]["quantity"] == 100
    overrides = store.query("select decision, reason_code, original_qty, final_qty from decisions "
                            "where decision in ('REJECT','EDIT') order by id")
    assert [o["decision"] for o in overrides] == ["REJECT", "EDIT"]
    assert overrides[1]["original_qty"] == 150 and overrides[1]["final_qty"] == 100
    assert store.one("select status from recommendations where rec_id=?", (r["SKU003"]["rec_id"],))["status"] == "REJECTED"
    with pytest.raises(decisions.DecisionError):
        decisions.approve(store, [r["SKU003"]["rec_id"]], "raghav", client)


def test_new_run_supersedes_pending(cfg, store):
    a = run_pipeline(cfg, store, use_ai=False)["run_id"]
    b = run_pipeline(cfg, store, use_ai=False)["run_id"]
    assert {x["status"] for x in store.recommendations(a)} == {"SUPERSEDED"}
    assert {x["status"] for x in store.recommendations(b)} == {"PENDING"}


def test_zoho_live_client_is_disabled_by_default(monkeypatch):
    monkeypatch.delenv("ZOHO_PO_ENABLED", raising=False)
    with pytest.raises(RuntimeError, match="disabled"):
        po.ZohoInventoryClient().create_purchase_order("X", {})
    assert isinstance(po.get_client(Path("/tmp/x")), po.DryRunZohoClient)


# ------------------------------------------------------------------------ Gemini
class FakeClient:
    def __init__(self, behaviour):
        self.behaviour, self.calls = behaviour, 0

    def generate(self, system, prompt):
        self.calls += 1
        if self.behaviour == "fail":
            raise RuntimeError("503 unavailable")
        if self.behaviour == "badjson":
            return "this is not json"
        facts = json.loads(prompt.split("FACTS:\n")[1])
        weekly = {"good": 1.0, "disagree": 3.0, "negative": -5.0, "alter": 1.0}[self.behaviour]
        notes = [{"sku_id": f["sku_id"], "confidence": "medium",
                  "forecast_next_4_weeks": [round((f["baseline_avg_weekly"] or 10) * weekly, 1)] * 4,
                  "explanation": "Cover is low. Reorder now.",
                  "what_looks_unusual": "x" if f["exceptions"] else None,
                  "what_to_check": "y" if f["exceptions"] else None,
                  **({"action": "PAUSE_ORDER", "recommended_qty": 1} if self.behaviour == "alter" else {})}
                 for f in facts]
        return json.dumps({"notes": notes})


def rules_snapshot(store, rid):
    return [(r["sku_id"], r["action"], r["recommended_qty"], r["flags"], r["priority"]) for r in store.recommendations(rid)]


@pytest.fixture
def baseline_snapshot(cfg):
    s = Store(cfg.db_path.parent / "base.db")
    rid = run_pipeline(cfg, s, use_ai=False)["run_id"]
    return rules_snapshot(s, rid)


@pytest.mark.parametrize("behaviour", ["fail", "badjson", "negative"])
def test_gemini_failure_degrades_to_rules_only(cfg, store, baseline_snapshot, behaviour):
    client = FakeClient(behaviour)
    res = run_pipeline(cfg, store, ai_client=client)
    assert res["status"] == "SUCCESS"
    rows = store.recommendations(res["run_id"])
    needing = [r for r in rows if r["action"] != "NO_ACTION"]
    assert needing and all(r["ai_status"] == "UNAVAILABLE" and r["ai_explanation"] is None for r in needing)
    assert rules_snapshot(store, res["run_id"]) == baseline_snapshot
    calls = store.query("select attempt, status, error from ai_calls where run_id=?", (res["run_id"],))
    assert [c["attempt"] for c in calls] == [1, 2] and all(c["status"] != "OK" for c in calls)   # one retry, logged


def test_gemini_missing_key_runs_rules_only(cfg, store, baseline_snapshot, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    res = run_pipeline(cfg, store)                   # ai_client="auto" -> no key
    assert res["status"] == "SUCCESS"
    assert {r["ai_status"] for r in store.recommendations(res["run_id"]) if r["action"] != "NO_ACTION"} == {"UNAVAILABLE"}
    assert rules_snapshot(store, res["run_id"]) == baseline_snapshot


def test_gemini_success_adds_notes_but_cannot_change_rules(cfg, store, baseline_snapshot):
    res = run_pipeline(cfg, store, ai_client=FakeClient("alter"))      # model tries to sneak in action/qty fields
    rows = store.recommendations(res["run_id"])
    ok = [r for r in rows if r["ai_status"] == "OK"]
    assert len(ok) == 7 and ok[0]["ai_explanation"] and json.loads(ok[0]["ai_forecast"])
    assert rules_snapshot(store, res["run_id"]) == baseline_snapshot
    assert all(r["ai_status"] == "SKIPPED" for r in rows if r["action"] == "NO_ACTION")
    logged = store.query("select prompt, response from ai_calls where run_id=?", (res["run_id"],))
    assert logged and "FACTS" in logged[0]["prompt"] and logged[0]["response"]


def test_forecast_disagreement_flag(cfg, store):
    good = run_pipeline(cfg, store, ai_client=FakeClient("good"))["run_id"]
    bad = run_pipeline(cfg, store, ai_client=FakeClient("disagree"))["run_id"]
    # "good" forecasts baseline x1.0 vs stat (baseline x1.25 in October): -20%, within 40%
    assert not any(r["forecast_disagrees"] for r in store.recommendations(good))
    # baseline x3.0 vs x1.25: +140%
    assert all(r["forecast_disagrees"] for r in store.recommendations(bad) if r["ai_status"] == "OK")


def test_gemini_prompt_forbids_changing_rules():
    s = ai_gemini.SYSTEM_PROMPT.lower()
    assert "may not change" in s and "do not do arithmetic" in s and "do not invent" in s


# ---------------------------------------------------------------------- full scale
def test_full_scale_run_under_a_minute(tmp_path):
    d = tmp_path / "scale"
    subprocess.run([sys.executable, str(ROOT / "scripts" / "generate_scale_data.py"), "--out", str(d)],
                   check=True, capture_output=True)
    cfg = load_config(data_dir=str(d), db_path=str(tmp_path / "scale.db"))
    s = Store(cfg.db_path)
    t = time.time()
    res = run_pipeline(cfg, s, use_ai=False)
    took = time.time() - t
    assert res["status"] == "SUCCESS" and res["n_recs"] == 400 and took < 60
    codes = {r["code"] for r in s.query("select distinct code from exceptions")}
    assert {"DISTRIBUTOR_ANOMALY", "NEW_SKU", "NO_DEMAND_STOCK_HELD", "SKU_SPIKE_OR_DROP"} <= codes
    fb = json.loads(s.one("select fallbacks from runs")["fallbacks"])
    assert "NO_DISTRIBUTOR_IN_SALES" not in fb
    assert {r["action"] for r in s.query("select distinct action from recommendations")} >= {"REORDER_NOW", "PAUSE_ORDER"}
