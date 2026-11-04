"""RUBRIC section 10 worked examples (1-10, 2b), cap, exceptions, ranking, distributor anomaly."""
import numpy as np
import pandas as pd

from freshroots.config import RulesParams
from freshroots.rules import evaluate


def one(mk, params, row, festival=False):
    res = evaluate(mk([dict(sku_id="X", **row)], festival=festival), params)
    return res.recs.iloc[0], res.exceptions


def test_ex1_high_demand(mk, params):
    r, _ = one(mk, params, dict(baseline=100, recent=130, stock=800))
    assert r.recent_vs_baseline_pct == 30.0 and r.cover_weeks == 8.0
    assert r["flags"] == ["HIGH_DEMAND"] and r.action == "REORDER_HIGH_DEMAND" and r.recommended_qty == 450
    assert r.priority == "P2"


def test_ex2_festival_default_toggle(mk, params):
    r, _ = one(mk, params, dict(baseline=100, recent=140, stock=700), festival=True)
    assert r.recent_vs_baseline_pct == 40.0 and r.cover_weeks == 5.6
    assert r["flags"] == ["HIGH_DEMAND", "STOCKOUT_RISK"]
    assert r.action == "REORDER_NOW" and r.recommended_qty == 450 and r.priority == "P1"


def test_ex2_without_uplift_stockout_would_be_missed(mk, params):
    r, _ = one(mk, params, dict(baseline=100, recent=140, stock=700), festival=False)
    assert r.cover_weeks == 7.0 and "STOCKOUT_RISK" not in r["flags"]


def test_ex2b_uplift_applies_to_r1(mk):
    p = RulesParams(festival_uplift_applies_to_r1_baseline=True)
    r, _ = one(mk, p, dict(baseline=100, recent=140, stock=700), festival=True)
    assert r.recent_vs_baseline_pct == 12.0
    assert r["flags"] == ["STOCKOUT_RISK"] and r.action == "REORDER_NOW" and r.recommended_qty == 300


def test_ex3_perishable(mk, params):
    a, _ = one(mk, params, dict(baseline=200, stock=500, perishable=True))
    b, _ = one(mk, params, dict(baseline=200, stock=700, perishable=True))
    c, _ = one(mk, params, dict(baseline=200, stock=900, perishable=True))
    assert (a.cover_weeks, a.action) == (2.5, "REORDER_NOW")
    assert (b.cover_weeks, b.action) == (3.5, "NO_ACTION")
    assert (c.cover_weeks, c.action) == (4.5, "PAUSE_ORDER")


def test_ex4_overstock(mk, params):
    r, _ = one(mk, params, dict(baseline=50, stock=800))
    assert r.cover_weeks == 16.0 and r.action == "PAUSE_ORDER" and r.priority == "P3" and r.recommended_qty == 0


def test_ex5_rule_conflict(mk, params):
    r, exc = one(mk, params, dict(baseline=100, recent=150, stock=1500))
    assert r.action == "PAUSE_REVIEW" and r.priority == "P2"
    assert list(exc["code"]) == ["RULE_CONFLICT"]
    assert r.review_before_approving


def test_ex6_reorder_now_high_demand(mk, params):
    r, _ = one(mk, params, dict(baseline=100, recent=135, stock=400))
    assert r.cover_weeks == 4.0 and r.action == "REORDER_NOW" and r.recommended_qty == 450 and r.priority == "P1"


def test_ex7_new_sku(mk, params):
    r, exc = one(mk, params, dict(baseline=100, stock=400, history=5))
    assert list(exc["code"]) == ["NEW_SKU"] and r.action == "EXCEPTION" and r.recommended_qty == 0
    assert r["flags"] == []


def test_ex8_no_demand_stock_held(mk, params):
    r, exc = one(mk, params, dict(baseline=0, stock=300))
    assert list(exc["code"]) == ["NO_DEMAND_STOCK_HELD"] and r.action == "EXCEPTION"


def test_ex9_boundary_cover_6_not_stockout(mk, params):
    r, _ = one(mk, params, dict(baseline=100, stock=600))
    assert r.cover_weeks == 6.0 and "STOCKOUT_RISK" not in r["flags"] and r.action == "NO_ACTION"


def test_ex10_boundary_exactly_20pct_not_high(mk, params):
    r, _ = one(mk, params, dict(baseline=100, recent=120, stock=800))
    assert r.recent_vs_baseline_pct == 20.0 and "HIGH_DEMAND" not in r["flags"]


def test_boundary_overstock_exactly_14(mk, params):
    r, _ = one(mk, params, dict(baseline=100, stock=1400))
    assert r.cover_weeks == 14.0 and r.action == "NO_ACTION"


def test_perishable_cap_stops_reorder_creating_overstock(mk, params):
    # cover 2.5 -> reorder 400 would give (500+400)/200 = 4.5 > 4 weeks: cap to 300
    r, _ = one(mk, params, dict(baseline=200, stock=500, perishable=True, std=400))
    assert r.action == "REORDER_NOW" and r.recommended_qty == 300 and r.qty_capped
    assert any(x["code"] == "QTY_CAPPED" for x in r.reasons)
    assert (500 + r.recommended_qty) / 200 <= 4


def test_cap_applies_to_high_demand_multiplier(mk, params):
    r, _ = one(mk, params, dict(baseline=200, recent=300, stock=500, perishable=True, std=300))
    # raw 450, ceiling 4*200-500 = 300
    assert r.recommended_qty == 300 and r.qty_capped


def test_missing_standard_qty_uses_target_cover_fallback(mk, params):
    r, _ = one(mk, params, dict(baseline=100, stock=200, std=np.nan))
    assert r.recommended_qty == 600 and "STANDARD_QTY_MISSING" in r.fallbacks   # (8-2)*100


def test_negative_and_missing_stock_are_data_issues(mk, params):
    res = evaluate(mk([dict(sku_id="A", baseline=100, stock=-5), dict(sku_id="B", baseline=100, stock=np.nan)]), params)
    assert set(res.exceptions["code"]) == {"DATA_ISSUE"} and set(res.recs["action"]) == {"EXCEPTION"}


def test_sku_spike_is_non_blocking_and_shows_review_flag(mk, params):
    d = mk([dict(sku_id="X", baseline=100, stock=300)])
    d.weekly.iloc[0, -1] = 400.0     # last week 4x the previous one
    res = evaluate(d, params)
    r = res.recs.iloc[0]
    assert "SKU_SPIKE_OR_DROP" in set(res.exceptions["code"])
    assert r.action == "REORDER_NOW" and r.review_before_approving


def test_gap_filled_sku_flagged_non_blocking(mk, params):
    res = evaluate(mk([dict(sku_id="X", baseline=100, stock=300, filled=3)]), params)
    e = res.exceptions.iloc[0]
    assert e.code == "DATA_ISSUE" and not e.blocking and res.recs.iloc[0].action == "REORDER_NOW"


def test_ranking_priority_then_perishable_then_value(mk, params):
    res = evaluate(mk([
        dict(sku_id="NP_SMALL", baseline=100, stock=500),
        dict(sku_id="NP_BIG", baseline=500, stock=500),
        dict(sku_id="PERISH", baseline=100, stock=290, perishable=True),
        dict(sku_id="OVER", baseline=50, stock=800),
        dict(sku_id="OK", baseline=100, stock=800),
    ]), params)
    assert list(res.recs["sku_id"]) == ["PERISH", "NP_BIG", "NP_SMALL", "OVER", "OK"]
    assert list(res.recs["rank"]) == [1, 2, 3, 4, 5]


def test_value_at_risk_in_units_without_price(mk, params):
    r, _ = one(mk, params, dict(baseline=100, stock=400))
    assert r.value_unit == "units" and r.value_at_risk == 200.0    # (6-4)*100


def test_rules_module_has_no_network_or_llm_imports():
    import freshroots.rules as m
    src = open(m.__file__).read()
    for banned in ("requests", "urllib", "socket", "genai", "http"):
        assert banned not in src


# ------------------------------------------------------------ distributor anomaly
def _dist(drop_last=None):
    weeks = pd.date_range(end="2026-10-12", periods=16, freq="7D")
    rows = []
    for d, level in (("D1", 100), ("D2", 80), ("D3", 120)):
        for i, w in enumerate(weeks):
            v = level + (i % 3) * 2
            if drop_last == d and i == len(weeks) - 1:
                v = level * 0.4
            rows.append(("X", d, w, v))
    return pd.DataFrame(rows, columns=["sku_id", "distributor_id", "week_start", "units"])


def test_distributor_anomaly_off_without_distributor_column(mk, params):
    res = evaluate(mk([dict(sku_id="X", baseline=100, stock=800)]), params)
    assert "DISTRIBUTOR_ANOMALY" not in set(res.exceptions["code"])
    assert "DISTRIBUTOR_ANOMALY_DISABLED_NO_DISTRIBUTOR_COLUMN" in res.run_fallbacks


def test_distributor_anomaly_on_when_column_present(mk, params):
    res = evaluate(mk([dict(sku_id="X", baseline=100, stock=800)], dist=_dist(drop_last="D2")), params)
    assert "DISTRIBUTOR_ANOMALY" in set(res.exceptions["code"])
    assert "DISTRIBUTOR_ANOMALY_DISABLED_NO_DISTRIBUTOR_COLUMN" not in res.run_fallbacks


def test_distributor_steady_no_anomaly(mk, params):
    res = evaluate(mk([dict(sku_id="X", baseline=100, stock=800)], dist=_dist()), params)
    assert "DISTRIBUTOR_ANOMALY" not in set(res.exceptions["code"])
