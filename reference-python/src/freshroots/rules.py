"""Context stage: Raghav's rules as a pure, deterministic, vectorised engine.

No network, no LLM, no I/O. Everything is driven by RulesParams (config/rules.yaml).
Strict inequalities exactly as RUBRIC section 4 words them.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from freshroots.cleanup import PlanningData
from freshroots.config import RulesParams

_R = 9  # decimals used to kill float noise before strict comparisons

PRIORITY_ORDER = {"P1": 1, "P2": 2, "P3": 3, "EX": 4, "": 5}
REORDER_ACTIONS = ("REORDER_NOW", "REORDER_HIGH_DEMAND")


@dataclass
class RulesResult:
    recs: pd.DataFrame
    exceptions: pd.DataFrame
    run_fallbacks: List[str]


def _nanmean(a: np.ndarray) -> np.ndarray:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(a, axis=1)


def distributor_anomalies(dist: pd.DataFrame, last_week_start: pd.Timestamp, p: RulesParams) -> pd.DataFrame:
    """SKU x distributor anomalies: |z| > threshold vs own trailing average, or a drop > 40%.

    Vectorised: one (pairs x weeks) matrix, no Python loop over distributors.
    """
    n_prior = p.baseline_window_weeks
    start = last_week_start - pd.Timedelta(days=7 * n_prior)
    d = dist[(dist["week_start"] >= start) & (dist["week_start"] <= last_week_start)]
    if d.empty:
        return pd.DataFrame(columns=["sku_id", "distributor_id", "latest", "trailing_mean", "z", "drop_pct"])
    pair_codes, pair_keys = pd.factorize(d["sku_id"] + "|" + d["distributor_id"])
    wk_idx = ((d["week_start"] - start).dt.days // 7).to_numpy()
    M = np.full((len(pair_keys), n_prior + 1), np.nan)
    M[pair_codes, wk_idx] = d["units"].clip(lower=0).to_numpy()
    prior = M[:, :-1]
    latest = np.nan_to_num(M[:, -1], nan=0.0)   # distributor stopped buying = 0
    valid = (~np.isnan(prior)).sum(axis=1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mean = np.nanmean(prior, axis=1)
        std = np.nanstd(prior, axis=1, ddof=1)
        z = np.where(std > 0, (latest - mean) / std, 0.0)
        drop = np.where(mean > 0, (mean - latest) / mean * 100.0, 0.0)
    ok = (valid >= p.distributor_anomaly_min_history_weeks) & (mean >= p.distributor_anomaly_min_avg_units)
    hit = ok & ((np.abs(np.round(z, _R)) > p.distributor_anomaly_z) | (np.round(drop, _R) > p.distributor_anomaly_drop_pct))
    cols = ["sku_id", "distributor_id", "latest", "trailing_mean", "z", "drop_pct"]
    if not hit.any():
        return pd.DataFrame(columns=cols)
    parts = pd.Series(pair_keys[hit]).str.split("|", n=1, expand=True)
    return pd.DataFrame({
        "sku_id": parts[0].to_numpy(), "distributor_id": parts[1].to_numpy(),
        "latest": latest[hit], "trailing_mean": mean[hit], "z": z[hit], "drop_pct": drop[hit],
    })


def evaluate(data: PlanningData, p: RulesParams) -> RulesResult:
    sku = data.sku.reset_index(drop=True)
    ids = sku["sku_id"].to_numpy()
    M = data.weekly.reindex(ids).to_numpy(dtype=float)
    n = len(ids)

    history = (~np.isnan(M)).sum(axis=1)
    baseline = _nanmean(M[:, -p.baseline_window_weeks:])
    recent = _nanmean(M[:, -p.recent_window_weeks:])
    festival = data.festival_active
    uplift = p.festival_uplift_pct / 100.0
    effective = baseline * (1 + uplift) if festival else baseline.copy()
    r1_base = effective if p.festival_uplift_applies_to_r1_baseline else baseline

    stock = sku["stock"].to_numpy(dtype=float)
    on_order = sku["on_order"].to_numpy(dtype=float) if "on_order" in sku else np.full(n, np.nan)
    has_oo = ~np.isnan(on_order)
    stock_with = stock + np.where(has_oo, on_order, 0.0)
    perish = sku["perishable"].to_numpy(dtype=bool)
    std_qty = sku["standard_qty"].to_numpy(dtype=float)
    price = sku["unit_price"].to_numpy(dtype=float) if "unit_price" in sku else np.full(n, np.nan)

    with np.errstate(divide="ignore", invalid="ignore"):
        pos = effective > 0
        cover = np.where(pos, np.round(stock_with / np.where(pos, effective, 1), _R), np.nan)
        cover_wo = np.where(pos, np.round(stock / np.where(pos, effective, 1), _R), np.nan)
        r1_pos = r1_base > 0
        pct = np.where(r1_pos, np.round((recent / np.where(r1_pos, r1_base, 1) - 1) * 100.0, _R), np.nan)

    lo = np.where(perish, p.perishable_min_cover_weeks, p.stockout_cover_weeks)
    hi_cap = np.where(perish, p.perishable_max_cover_weeks, p.overstock_cover_weeks)
    with np.errstate(invalid="ignore"):
        high = pct > p.high_demand_threshold_pct
        stockout = cover < lo
        overstock = cover > hi_cap
    high, stockout, overstock = (np.nan_to_num(x, nan=0).astype(bool) if x.dtype != bool else x
                                 for x in (high, stockout, overstock))

    # ---------------- exceptions ---------------------------------------------
    exc: List[Dict] = []

    def add(mask, code, blocking, text):
        for i in np.flatnonzero(mask):
            exc.append({"sku_id": ids[i], "code": code, "blocking": blocking, "detail": text(i)})

    new_sku = history < p.min_history_weeks
    add(new_sku, "NEW_SKU", True,
        lambda i: "Only %d weeks of sales history (need %d)" % (history[i], p.min_history_weeks))
    no_demand = (~new_sku) & (np.nan_to_num(baseline, nan=-1) == 0) & (stock > 0)
    add(no_demand, "NO_DEMAND_STOCK_HELD", True,
        lambda i: "No sales in the last %d weeks but %d units on hand" % (p.baseline_window_weeks, stock[i]))
    bad_stock = np.isnan(stock) | (stock < 0)
    add(bad_stock, "DATA_ISSUE", True,
        lambda i: "Inventory missing" if np.isnan(stock[i]) else "Negative stock (%d)" % stock[i])
    overlap = stockout & overstock
    add(overlap, "DATA_ISSUE", True, lambda i: "Stockout and overstock limits overlap: check config")
    gap = sku["filled_weeks"].to_numpy() > p.max_filled_weeks
    add(gap, "DATA_ISSUE", False,
        lambda i: "%d missing sales weeks were filled with 0" % sku["filled_weeks"].iloc[i])

    # week-on-week change in total SKU units
    if M.shape[1] >= 2:
        last, prev = M[:, -1], M[:, -2]
        both = ~np.isnan(last) & ~np.isnan(prev)
        with np.errstate(divide="ignore", invalid="ignore"):
            wow = np.where(prev > 0, np.round((last - prev) / np.where(prev > 0, prev, 1) * 100.0, _R),
                           np.where(last > 0, np.inf, 0.0))
        spike = both & (np.abs(wow) > p.sku_wow_spike_pct)
        add(spike, "SKU_SPIKE_OR_DROP", False,
            lambda i: "Week-on-week change %s%% (%d -> %d units)" % (
                "inf" if np.isinf(wow[i]) else "%+.0f" % wow[i], prev[i], last[i]))

    run_fallbacks: List[str] = []
    if data.dist_weekly is not None:
        anomalies = distributor_anomalies(data.dist_weekly, data.last_week_start, p)
        if len(anomalies):
            for sid, g in anomalies.groupby("sku_id"):
                worst = g.iloc[np.argmax(np.abs(g["z"].to_numpy()) + g["drop_pct"].to_numpy())]
                exc.append({"sku_id": sid, "code": "DISTRIBUTOR_ANOMALY", "blocking": False,
                            "detail": "%d distributor(s) unusual; e.g. %s sold %d vs avg %.0f (z=%.1f, drop %.0f%%)" % (
                                len(g), worst["distributor_id"], worst["latest"], worst["trailing_mean"],
                                worst["z"], worst["drop_pct"])})
    else:
        run_fallbacks.append("DISTRIBUTOR_ANOMALY_DISABLED_NO_DISTRIBUTOR_COLUMN")

    blocked = np.zeros(n, dtype=bool)
    for e in exc:
        if e["blocking"]:
            blocked[np.flatnonzero(ids == e["sku_id"])] = True

    # ---------------- decision table -----------------------------------------
    act = np.full(n, "NO_ACTION", dtype=object)
    mult = np.full(n, np.nan)
    prio = np.full(n, "", dtype=object)
    conflict = (~stockout) & high & overstock
    m = stockout & high & ~overstock
    act[m], mult[m], prio[m] = "REORDER_NOW", p.high_demand_reorder_multiplier, "P1"
    m = stockout & ~high & ~overstock
    act[m], mult[m], prio[m] = "REORDER_NOW", 1.0, "P1"
    m = ~stockout & high & ~overstock
    act[m], mult[m], prio[m] = "REORDER_HIGH_DEMAND", p.high_demand_reorder_multiplier, "P2"
    m = ~stockout & ~high & overstock
    act[m], mult[m], prio[m] = "PAUSE_ORDER", 0.0, "P3"
    act[conflict], mult[conflict], prio[conflict] = "PAUSE_REVIEW", 0.0, "P2"
    for i in np.flatnonzero(conflict & ~blocked):
        exc.append({"sku_id": ids[i], "code": "RULE_CONFLICT", "blocking": False,
                    "detail": "High demand (%+.1f%%) but cover %.1f weeks is above the overstock limit" % (pct[i], cover[i])})
    act[blocked], mult[blocked], prio[blocked] = "EXCEPTION", np.nan, "EX"

    # ---------------- quantity with cap --------------------------------------
    target = np.where(perish, p.perishable_target_cover_weeks, p.target_cover_weeks)
    with np.errstate(invalid="ignore"):
        fb_base = np.maximum(0.0, target - np.nan_to_num(cover, nan=0.0)) * np.nan_to_num(effective, nan=0.0)
    used_qty_fallback = np.isnan(std_qty)
    base_qty = np.where(used_qty_fallback, fb_base, std_qty)
    is_reorder = np.isin(act, REORDER_ACTIONS)
    raw_qty = np.where(is_reorder, np.ceil(np.round(base_qty * np.nan_to_num(mult), _R)), 0.0)
    allowed = np.floor(np.round(hi_cap * np.nan_to_num(effective) - np.nan_to_num(stock_with), _R))
    allowed = np.maximum(allowed, 0.0)
    qty = np.where(is_reorder, np.minimum(raw_qty, allowed), 0.0)
    capped = is_reorder & (raw_qty > allowed)

    # ---------------- value at risk (units unless a price exists) ---------------
    with np.errstate(invalid="ignore"):
        short_units = np.maximum(0.0, (lo - cover) * effective)
        excess_units = np.maximum(0.0, (cover - hi_cap) * effective)
        demand_gap = np.maximum(0.0, recent - r1_base)
    var = np.zeros(n)
    so_rows = stockout & ~blocked
    var[so_rows] = short_units[so_rows]
    ov_rows = overstock & ~blocked
    var[ov_rows] = excess_units[ov_rows]
    hd_rows = high & ~stockout & ~overstock & ~blocked
    var[hd_rows] = demand_gap[hd_rows]
    has_price = ~np.isnan(price)
    var_value = np.where(has_price, var * np.nan_to_num(price), var)
    var_unit = np.where(has_price, "INR", "units")

    # ---------------- assemble ---------------------------------------------------
    exc_df = pd.DataFrame(exc, columns=["sku_id", "code", "blocking", "detail"])
    codes = exc_df.groupby("sku_id")["code"].apply(list).to_dict() if len(exc_df) else {}
    fallbacks_row: List[List[str]] = []
    reasons: List[List[dict]] = []
    flags: List[List[str]] = []
    for i in range(n):
        fb = []
        if used_qty_fallback[i] and is_reorder[i]:
            fb.append("STANDARD_QTY_MISSING")
        fallbacks_row.append(fb)
        f = []
        r = []
        if not blocked[i]:
            if high[i]:
                f.append("HIGH_DEMAND")
                r.append({"rule": "R1", "code": "HIGH_DEMAND", "recent_vs_baseline_pct": float(pct[i]),
                          "threshold_pct": p.high_demand_threshold_pct, "baseline_used": "effective" if p.festival_uplift_applies_to_r1_baseline else "raw"})
            if stockout[i]:
                f.append("STOCKOUT_RISK")
                r.append({"rule": "R2", "code": "STOCKOUT_RISK", "cover_weeks": float(cover[i]), "limit_weeks": float(lo[i]),
                          "perishable": bool(perish[i])})
            if overstock[i]:
                f.append("OVERSTOCK_RISK")
                r.append({"rule": "R3", "code": "OVERSTOCK_RISK", "cover_weeks": float(cover[i]), "limit_weeks": float(hi_cap[i]),
                          "perishable": bool(perish[i])})
            if festival and (stockout[i] or overstock[i] or high[i] or act[i] == "NO_ACTION"):
                r.append({"rule": "R4", "code": "FESTIVAL_UPLIFT", "uplift_pct": p.festival_uplift_pct})
            if capped[i]:
                r.append({"rule": "QTY_CAP", "code": "QTY_CAPPED", "uncapped_qty": float(raw_qty[i]),
                          "capped_qty": float(qty[i]), "ceiling_weeks": float(hi_cap[i])})
        for c in codes.get(ids[i], []):
            r.append({"rule": "EXCEPTION", "code": c})
        flags.append(f)
        reasons.append(r)

    ex_codes = [codes.get(s, []) for s in ids]
    has_action = np.isin(act, REORDER_ACTIONS + ("PAUSE_ORDER", "PAUSE_REVIEW"))
    review = has_action & np.array([len(c) > 0 for c in ex_codes])

    recs = pd.DataFrame({
        "sku_id": ids,
        "sku_name": sku["sku_name"].to_numpy(),
        "category": sku["category"].to_numpy(),
        "perishable": perish,
        "distributor_id": sku["distributor_id"].to_numpy(),
        "stock": stock,
        "standard_qty": std_qty,
        "history_weeks": history,
        "baseline_avg_weekly": baseline,
        "recent_avg_weekly": recent,
        "effective_avg_weekly": effective,
        "festival_active": festival,
        "cover_weeks": cover,
        "cover_weeks_without_on_order": cover_wo,
        "recent_vs_baseline_pct": pct,
        "flags": flags,
        "action": act,
        "qty_multiplier": mult,
        "base_qty": np.where(is_reorder, base_qty, np.nan),
        "recommended_qty": qty,
        "qty_capped": capped,
        "priority": prio,
        "value_at_risk": var_value,
        "value_unit": var_unit,
        "exception_codes": ex_codes,
        "review_before_approving": review,
        "reasons": reasons,
        "fallbacks": fallbacks_row,
    })
    recs["_p"] = recs["priority"].map(PRIORITY_ORDER)
    recs = recs.sort_values(["_p", "perishable", "value_at_risk", "sku_id"],
                            ascending=[True, False, False, True], kind="mergesort").drop(columns="_p")
    recs.insert(0, "rank", np.arange(1, n + 1))
    return RulesResult(recs.reset_index(drop=True), exc_df, run_fallbacks)
