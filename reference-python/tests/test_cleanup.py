"""Every hard stop and soft fix in RUBRIC section 7."""
from datetime import date

import pandas as pd
import pytest

from freshroots.cleanup import clean, last_complete_week_start, parse_iso_week
from freshroots.ingest import CsvDataSource, SchemaError


def codes(res, sev=None):
    return {i.code for i in res.issues if sev is None or i.severity == sev}


def run(raw, cfg, as_of=None):
    return clean(raw, cfg.rules, cfg.schema_map, as_of)


def test_seed_defaults(raw, cfg):
    res = run(raw, cfg)
    assert res.ok and res.metrics["last_week"] == "2026-W42" and res.data.festival_active is True
    assert res.metrics["as_of"] == "2026-10-19" and res.metrics["sales_age_days"] == 1
    assert {"NO_UNIT_PRICE", "NO_LEAD_TIME", "NO_ON_ORDER_UNITS", "NO_DISTRIBUTOR_IN_SALES"} <= set(res.fallbacks)
    assert res.data.weekly.shape == (15, 16) and res.data.dist_weekly is None


def test_week_helpers():
    assert parse_iso_week("2026-W42") == pd.Timestamp("2026-10-12")
    assert last_complete_week_start(date(2026, 10, 19)) == pd.Timestamp("2026-10-12")
    assert last_complete_week_start(date(2026, 10, 22)) == pd.Timestamp("2026-10-12")


# ------------------------------------------------------------------ hard stops
def test_hard_stop_stale_data_vs_asof_not_wallclock(raw, cfg):
    res = run(raw, cfg, as_of=date(2026, 11, 16))
    assert not res.ok and {"STALE_SALES", "STALE_INVENTORY"} <= codes(res, "HARD_STOP") and res.data is None


def test_hard_stop_too_many_skus_without_inventory(raw, cfg):
    raw["current_inventory"] = raw["current_inventory"].iloc[:11]      # 4 of 15 missing = 26.7%
    res = run(raw, cfg)
    assert not res.ok and "TOO_MANY_SKUS_WITHOUT_INVENTORY" in codes(res, "HARD_STOP")


def test_missing_inventory_below_20pct_is_soft(raw, cfg):
    raw["current_inventory"] = raw["current_inventory"].iloc[:13]      # 2 of 15 = 13%
    res = run(raw, cfg)
    assert res.ok and "MISSING_INVENTORY_ROW" in codes(res, "SOFT_FIX")


def test_hard_stop_missing_required_column(cfg, tmp_path):
    import shutil
    d = tmp_path / "bad"
    shutil.copytree(cfg.data_dir, d)
    df = pd.read_csv(d / "weekly_sales.csv").drop(columns=["Units_Sold"])
    df.to_csv(d / "weekly_sales.csv", index=False)
    with pytest.raises(SchemaError, match="Units_Sold"):
        CsvDataSource(d, cfg.schema_map).load()


def test_hard_stop_missing_required_file(cfg, tmp_path):
    with pytest.raises(SchemaError, match="missing"):
        CsvDataSource(tmp_path, cfg.schema_map).load()


# ------------------------------------------------------------------- soft fixes
def test_soft_ids_normalised(raw, cfg):
    s = raw["weekly_sales"]
    s.loc[0, "sku_id"] = " sku-1 "
    res = run(raw, cfg)
    assert "IDS_NORMALISED" in codes(res, "SOFT_FIX")
    assert "SKU001" in res.data.weekly.index and "UNKNOWN_SKU_SALES_QUARANTINED" not in codes(res)


def test_soft_duplicates_keep_last(raw, cfg):
    s = raw["weekly_sales"]
    dup = s.iloc[[0]].copy()
    dup["units_sold"] = "999"
    raw["weekly_sales"] = pd.concat([s, dup], ignore_index=True)
    res = run(raw, cfg)
    assert any(i.code == "DUPLICATE_SALES_ROWS" and i.count == 1 for i in res.issues)
    assert res.data.weekly.loc["SKU001"].iloc[0] == 999


def test_soft_unknown_sku_quarantined(raw, cfg):
    s = raw["weekly_sales"]
    extra = s.iloc[[0]].copy()
    extra["sku_id"] = "SKU999"
    raw["weekly_sales"] = pd.concat([s, extra], ignore_index=True)
    i = raw["current_inventory"].iloc[[0]].copy()
    i["sku_id"] = "SKU998"
    raw["current_inventory"] = pd.concat([raw["current_inventory"], i], ignore_index=True)
    res = run(raw, cfg)
    assert {"UNKNOWN_SKU_SALES_QUARANTINED", "UNKNOWN_SKU_INVENTORY_QUARANTINED"} <= codes(res, "SOFT_FIX")
    assert "SKU999" not in res.data.weekly.index


def test_soft_negative_units_netted_and_floored(raw, cfg):
    s = raw["weekly_sales"]
    s.loc[0, "units_sold"] = "-50"                      # SKU001 W27 becomes a net return
    res = run(raw, cfg)
    assert "NEGATIVE_UNITS_NETTED" in codes(res, "SOFT_FIX")
    assert res.data.weekly.loc["SKU001"].iloc[0] == 0


def test_soft_missing_weeks_filled_and_flagged_over_two(raw, cfg):
    s = raw["weekly_sales"]
    drop = s[(s.sku_id == "SKU002") & s.week.isin(["2026-W30", "2026-W31", "2026-W32"])].index
    raw["weekly_sales"] = s.drop(drop)
    res = run(raw, cfg)
    assert res.data.filled_weeks["SKU002"] == 3
    assert any(i.code == "SKU_MANY_WEEKS_FILLED" and i.sku_id == "SKU002" for i in res.issues)
    assert res.data.weekly.loc["SKU002"].iloc[3] == 0


def test_soft_missing_standard_qty_fallback(raw, cfg):
    raw["sku_master"].loc[0, "standard_order_qty"] = ""
    res = run(raw, cfg)
    assert "STANDARD_QTY_MISSING" in res.fallbacks and pd.isna(res.data.sku.loc[0, "standard_qty"])


def test_distributor_column_switches_anomaly_path_on(raw, cfg):
    m = raw["sku_master"].set_index("sku_id")["distributor_id"]
    raw["weekly_sales"]["distributor_id"] = raw["weekly_sales"]["sku_id"].map(m)
    res = run(raw, cfg)
    assert res.data.dist_weekly is not None and "NO_DISTRIBUTOR_IN_SALES" not in res.fallbacks


def test_festival_flag_follows_calendar_and_asof(raw, cfg):
    assert run(raw, cfg, as_of=date(2026, 9, 14)).data.festival_active is False
    assert run(raw, cfg, as_of=date(2026, 10, 19)).data.festival_active is True


def test_festival_fallback_when_calendar_lacks_month(raw, cfg):
    raw["calendar"] = raw["calendar"][raw["calendar"].year != "2026"]
    res = run(raw, cfg)
    assert "FESTIVAL_FROM_CONFIG" in res.fallbacks and res.data.festival_active is True
