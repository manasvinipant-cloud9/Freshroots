"""Processing stage: data cleanup and validation (RUBRIC section 7).

Hard stops abort the run (status FAILED, no recommendations). Soft fixes are
applied and logged. The output is a PlanningData object the rules engine uses.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from freshroots.config import RulesParams


@dataclass
class Issue:
    severity: str          # HARD_STOP | SOFT_FIX | FALLBACK | INFO
    code: str
    count: int = 0
    detail: str = ""
    sku_id: Optional[str] = None


@dataclass
class PlanningData:
    sku: pd.DataFrame                 # one row per active SKU (see _build_sku)
    weekly: pd.DataFrame              # index sku_id, columns week_start (Timestamp), NaN before first sale
    festival_active: bool
    as_of: date
    last_week_start: pd.Timestamp
    dist_weekly: Optional[pd.DataFrame] = None   # long: sku_id, distributor_id, week_start, units
    filled_weeks: Dict[str, int] = field(default_factory=dict)

    @property
    def last_week_label(self) -> str:
        iso = self.last_week_start.isocalendar()
        return "%d-W%02d" % (iso[0], iso[1])


@dataclass
class CleanResult:
    issues: List[Issue]
    data: Optional[PlanningData] = None
    fallbacks: List[str] = field(default_factory=list)
    metrics: Dict[str, Any] = field(default_factory=dict)

    @property
    def hard_stops(self) -> List[Issue]:
        return [i for i in self.issues if i.severity == "HARD_STOP"]

    @property
    def ok(self) -> bool:
        return not self.hard_stops


# --------------------------------------------------------------------- helpers
_ID_RE = re.compile(r"^([A-Za-z]+)[\-_ ]?(\d+)$")


def _normalise_ids(series: pd.Series, width: int) -> pd.Series:
    """Trim, upper-case and zero-pad the numeric part (SKU1 / sku-001 -> SKU001)."""
    uniq = series.astype(str).unique()
    mapping = {}
    for raw in uniq:
        s = raw.strip().upper()
        m = _ID_RE.match(s)
        mapping[raw] = "%s%s" % (m.group(1), str(int(m.group(2))).zfill(width)) if m else s
    return series.astype(str).map(mapping)


def _id_width(series: pd.Series) -> int:
    widths = [len(m.group(2)) for m in (_ID_RE.match(str(s).strip()) for s in series.unique()) if m]
    return max(widths) if widths else 3


def parse_iso_week(label: str) -> pd.Timestamp:
    """'2026-W42' -> Monday of that ISO week."""
    return pd.Timestamp(datetime.strptime(label.strip().upper() + "-1", "%G-W%V-%u"))


def last_complete_week_start(as_of: date) -> pd.Timestamp:
    monday = pd.Timestamp(as_of) - pd.Timedelta(days=as_of.weekday())
    return monday - pd.Timedelta(days=7)


def _to_bool(s: pd.Series) -> pd.Series:
    return s.astype(str).str.strip().str.upper().isin(["TRUE", "1", "YES", "Y"])


# ------------------------------------------------------------------------ main
def clean(raw: Dict[str, pd.DataFrame], p: RulesParams, schema_map: Dict[str, Any],
          as_of: Optional[date] = None) -> CleanResult:
    issues: List[Issue] = []
    fallbacks: List[str] = []
    metrics: Dict[str, Any] = {}

    def hard(code, detail, count=0):
        issues.append(Issue("HARD_STOP", code, count, detail))

    def soft(code, count, detail, sku_id=None):
        issues.append(Issue("SOFT_FIX", code, count, detail, sku_id))

    def info(code, count, detail):
        issues.append(Issue("INFO", code, count, detail))

    def fallback(code, detail, count=0):
        fallbacks.append(code)
        issues.append(Issue("FALLBACK", code, count, detail))

    sku_raw = raw["sku_master"].copy()
    sales = raw["weekly_sales"].copy()
    inv = raw["current_inventory"].copy()
    cal = raw["calendar"].copy()

    # ---- IDs ---------------------------------------------------------------
    width = _id_width(sku_raw["sku_id"])
    n_changed = 0
    for df, col in ((sku_raw, "sku_id"), (sales, "sku_id"), (inv, "sku_id")):
        before = df[col].astype(str)
        df[col] = _normalise_ids(df[col], width)
        n_changed += int((before != df[col]).sum())
    if "distributor_id" in sales.columns:
        dwidth = _id_width(raw["distributor_master"]["distributor_id"])
        before = sales["distributor_id"].astype(str)
        sales["distributor_id"] = _normalise_ids(sales["distributor_id"], dwidth)
        n_changed += int((before != sales["distributor_id"]).sum())
    sku_raw["distributor_id"] = _normalise_ids(sku_raw["distributor_id"], _id_width(raw["distributor_master"]["distributor_id"]))
    if n_changed:
        soft("IDS_NORMALISED", n_changed, "Trimmed / upper-cased / zero-padded IDs")

    dups_master = int(sku_raw.duplicated("sku_id", keep="last").sum())
    if dups_master:
        sku_raw = sku_raw.drop_duplicates("sku_id", keep="last")
        soft("DUPLICATE_SKU_MASTER", dups_master, "Duplicate SKU rows in master: kept last")
    active = set(sku_raw["sku_id"])

    # ---- sales types, quarantine, dedupe -------------------------------------
    has_dist = "distributor_id" in sales.columns
    try:
        wk_map = {w: parse_iso_week(w) for w in sales["week"].unique()}
    except ValueError as e:
        hard("BAD_WEEK_FORMAT", "Week column is not ISO like 2026-W27: %s" % e)
        return CleanResult(issues, None, fallbacks, metrics)
    sales["week_start"] = sales["week"].map(wk_map)
    sales["units"] = pd.to_numeric(sales["units_sold"], errors="coerce")
    bad_units = int(sales["units"].isna().sum())
    if bad_units:
        soft("NON_NUMERIC_UNITS", bad_units, "Rows with non-numeric Units_Sold dropped")
        sales = sales[sales["units"].notna()]

    unknown = ~sales["sku_id"].isin(active)
    if unknown.any():
        soft("UNKNOWN_SKU_SALES_QUARANTINED", int(unknown.sum()),
             "Sales rows for SKUs not in master: %s" % sorted(sales.loc[unknown, "sku_id"].unique())[:10])
        sales = sales[~unknown]
    key = ["week_start", "sku_id"] + (["distributor_id"] if has_dist else [])
    dups = int(sales.duplicated(key, keep="last").sum())
    if dups:
        sales = sales.drop_duplicates(key, keep="last")
        soft("DUPLICATE_SALES_ROWS", dups, "Duplicate (week, sku%s) rows: kept last" % (", distributor" if has_dist else ""))

    # ---- as-of date and the last complete week ------------------------------
    inv["as_of_dt"] = pd.to_datetime(inv["as_of_date"], errors="coerce")
    if inv["as_of_dt"].isna().all():
        hard("BAD_INVENTORY_DATE", "Inventory As_Of_Date could not be parsed")
        return CleanResult(issues, None, fallbacks, metrics)
    inv_date = inv["as_of_dt"].max().date()
    if as_of is None:
        as_of = inv_date
        info("AS_OF_DEFAULT", 0, "As-of date defaulted to the inventory As_Of_Date %s" % as_of)
    last_wk = last_complete_week_start(as_of)
    late = sales["week_start"] > last_wk
    if late.any():
        info("SALES_AFTER_LAST_COMPLETE_WEEK", int(late.sum()),
             "Rows after the last complete week (%s) excluded" % last_wk.date())
        sales = sales[~late]
    if sales.empty:
        hard("NO_SALES", "No sales rows left at or before the last complete week")
        return CleanResult(issues, None, fallbacks, metrics)

    # ---- freshness gate (against as-of, not the wall clock) ------------------
    latest_wk_end = sales["week_start"].max() + pd.Timedelta(days=6)
    sales_age = (pd.Timestamp(as_of) - latest_wk_end).days
    inv_age = (pd.Timestamp(as_of) - pd.Timestamp(inv_date)).days
    metrics.update(sales_age_days=int(sales_age), inventory_age_days=int(inv_age),
                   as_of=str(as_of), last_week=None)
    if sales_age > p.max_data_age_days:
        hard("STALE_SALES", "Latest sales week ends %s, %d days before as-of %s (max %d)"
             % (latest_wk_end.date(), sales_age, as_of, p.max_data_age_days), sales_age)
    if inv_age > p.max_data_age_days:
        hard("STALE_INVENTORY", "Inventory As_Of_Date %s is %d days before as-of %s (max %d)"
             % (inv_date, inv_age, as_of, p.max_data_age_days), inv_age)
    if inv_age < 0:
        info("INVENTORY_NEWER_THAN_AS_OF", -inv_age,
             "Inventory snapshot (%s) is newer than the as-of date: replay mode, current stock vs older sales" % inv_date)

    # ---- inventory ----------------------------------------------------------
    inv["stock"] = pd.to_numeric(inv["units_on_hand"], errors="coerce")
    unk_inv = ~inv["sku_id"].isin(active)
    if unk_inv.any():
        soft("UNKNOWN_SKU_INVENTORY_QUARANTINED", int(unk_inv.sum()), "Inventory rows for SKUs not in master")
        inv = inv[~unk_inv]
    inv_dups = int(inv.duplicated(["sku_id", "location"], keep="last").sum())
    if inv_dups:
        inv = inv.drop_duplicates(["sku_id", "location"], keep="last")
        soft("DUPLICATE_INVENTORY_ROWS", inv_dups, "Duplicate (sku, location) rows: kept last")
    if inv["sku_id"].duplicated().any():
        info("MULTI_LOCATION_STOCK", int(inv["sku_id"].duplicated().sum()), "Stock summed across locations")
    agg = {"stock": lambda s: s.sum(min_count=1)}
    has_oo = "on_order_units" in inv.columns
    if has_oo:
        inv["on_order"] = pd.to_numeric(inv["on_order_units"], errors="coerce").fillna(0)
        agg["on_order"] = "sum"
    inv_by_sku = inv.groupby("sku_id").agg(agg)

    missing_inv = [s for s in active if s not in inv_by_sku.index or pd.isna(inv_by_sku.loc[s, "stock"])]
    pct_missing = 100.0 * len(missing_inv) / max(len(active), 1)
    metrics["pct_skus_missing_inventory"] = round(pct_missing, 2)
    if missing_inv:
        soft("MISSING_INVENTORY_ROW", len(missing_inv), "Active SKUs without inventory: %s" % sorted(missing_inv)[:10])
    if pct_missing > p.max_missing_inventory_pct:
        hard("TOO_MANY_SKUS_WITHOUT_INVENTORY",
             "%.1f%% of active SKUs have no inventory row (max %.0f%%)" % (pct_missing, p.max_missing_inventory_pct),
             len(missing_inv))
    neg_stock = inv_by_sku.index[inv_by_sku["stock"] < 0].tolist()
    if neg_stock:
        soft("NEGATIVE_STOCK", len(neg_stock), "Negative Units_On_Hand: %s (SKU sent to exceptions)" % neg_stock[:10])

    if sku_raw.empty:
        hard("NO_ACTIVE_SKUS", "SKU master is empty")
    if not clean_ok(issues):
        return CleanResult(issues, None, fallbacks, metrics)

    # ---- weekly demand per SKU: net returns, floor at 0 -----------------------
    neg_rows = int((sales["units"] < 0).sum())
    sku_week = sales.groupby(["sku_id", "week_start"], sort=False)["units"].sum()
    floored = int((sku_week < 0).sum())
    if neg_rows:
        soft("NEGATIVE_UNITS_NETTED", neg_rows,
             "Negative Units_Sold treated as returns, netted per SKU-week; %d SKU-weeks floored at 0" % floored)
    sku_week = sku_week.clip(lower=0)
    wide = sku_week.unstack("week_start")
    all_weeks = pd.date_range(wide.columns.min(), last_wk, freq="7D")
    wide = wide.reindex(index=sorted(active), columns=all_weeks)
    arr = wide.to_numpy(dtype=float)
    started = np.maximum.accumulate(~np.isnan(arr), axis=1)
    gaps = np.isnan(arr) & started
    arr = np.where(gaps, 0.0, arr)
    wide = pd.DataFrame(arr, index=wide.index, columns=wide.columns)
    wide.index.name = "sku_id"
    filled = pd.Series(gaps.sum(axis=1), index=wide.index)
    filled_weeks = {k: int(v) for k, v in filled.items() if v > 0}
    if filled_weeks:
        soft("MISSING_WEEKS_FILLED", int(filled.sum()),
             "%d SKU(s) had missing weeks filled with 0" % len(filled_weeks))
    for sku_id, n in filled_weeks.items():
        if n > p.max_filled_weeks and len(filled_weeks) <= 50:
            soft("SKU_MANY_WEEKS_FILLED", n, "%d weeks filled with 0 (> %d): flagged" % (n, p.max_filled_weeks), sku_id)
    metrics["last_week"] = "%d-W%02d" % (last_wk.isocalendar()[0], last_wk.isocalendar()[1])

    # ---- distributor-level sales (switches DISTRIBUTOR_ANOMALY on) ------------
    dist_weekly = None
    if has_dist:
        d = sales[["sku_id", "distributor_id", "week_start", "units"]]
        dist_weekly = d.groupby(["sku_id", "distributor_id", "week_start"], sort=False, as_index=False)["units"].sum()
    else:
        fallback("NO_DISTRIBUTOR_IN_SALES",
                 "Sales file has no Distributor_ID column: DISTRIBUTOR_ANOMALY is switched off")

    # ---- SKU table ------------------------------------------------------------
    pv = schema_map["perishability_values"]
    sku = sku_raw.set_index("sku_id").loc[sorted(active)].copy()
    sku["perishable"] = sku["perishability"].astype(str).str.strip().str.lower() == str(pv["perishable"]).lower()
    sku["standard_qty"] = pd.to_numeric(sku["standard_order_qty"], errors="coerce")
    n_no_qty = int(sku["standard_qty"].isna().sum())
    if n_no_qty:
        fallback("STANDARD_QTY_MISSING", "%d SKU(s) lack a standard reorder qty: target-cover formula used" % n_no_qty, n_no_qty)
    sku["stock"] = inv_by_sku["stock"].reindex(sku.index)
    sku["on_order"] = inv_by_sku["on_order"].reindex(sku.index).fillna(0) if has_oo else np.nan
    if "unit_price" in sku.columns:
        sku["unit_price"] = pd.to_numeric(sku["unit_price"], errors="coerce")
    else:
        sku["unit_price"] = np.nan
        fallback("NO_UNIT_PRICE", "No unit price in the data: ranking and value-at-risk are in units, not rupees")
    if "lead_time_days" not in sku.columns:
        fallback("NO_LEAD_TIME", "No lead time in the data: not used by any rule")
    if not has_oo:
        fallback("NO_ON_ORDER_UNITS", "No on-order / open-PO units: cover uses on-hand stock only")
    fallback("STOCK_AT_SKU_LEVEL", "Stock is one figure per SKU (not per distributor)")
    sku["filled_weeks"] = filled.reindex(sku.index).fillna(0).astype(int)
    sku = sku.reset_index()

    # ---- festival flag -----------------------------------------------------------
    cal["year_i"] = pd.to_numeric(cal["year"], errors="coerce")
    cal["month_i"] = pd.to_numeric(cal["month"], errors="coerce")
    row = cal[(cal["year_i"] == as_of.year) & (cal["month_i"] == as_of.month)]
    if len(row):
        festival = bool(_to_bool(row["is_festival_month"]).iloc[-1])
    else:
        festival = as_of.month in p.festival_months
        fallback("FESTIVAL_FROM_CONFIG", "As-of month %d not in calendar file: used festival_months from rules.yaml" % as_of.month)
    metrics["festival_active"] = festival

    data = PlanningData(sku=sku, weekly=wide, festival_active=festival, as_of=as_of,
                        last_week_start=last_wk, dist_weekly=dist_weekly, filled_weeks=filled_weeks)
    return CleanResult(issues, data, fallbacks, metrics)


def clean_ok(issues: List[Issue]) -> bool:
    return not any(i.severity == "HARD_STOP" for i in issues)
