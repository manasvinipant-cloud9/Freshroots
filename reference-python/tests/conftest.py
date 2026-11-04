import copy
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from freshroots.cleanup import PlanningData  # noqa: E402
from freshroots.config import RulesParams, load_config  # noqa: E402
from freshroots.ingest import CsvDataSource  # noqa: E402


@pytest.fixture
def cfg(tmp_path):
    c = load_config(db_path=str(tmp_path / "t.db"))
    c.po_drafts_dir = tmp_path / "po"
    return c


@pytest.fixture
def raw(cfg):
    return copy.deepcopy(CsvDataSource(cfg.data_dir, cfg.schema_map).load())


@pytest.fixture
def params():
    return RulesParams()


def make_data(rows, festival=False, weeks=16, dist=None):
    """rows: dicts with sku_id, baseline, recent, stock; optional perishable, std, history.

    The 12-week mean equals `baseline` and the last 4 weeks equal `recent`, so the worked
    examples in RUBRIC section 10 can be written exactly as they read.
    """
    last = pd.Timestamp("2026-10-12")
    cols = pd.date_range(end=last, periods=weeks, freq="7D")
    series, skus = {}, []
    for r in rows:
        b, rc = r["baseline"], r.get("recent", r["baseline"])
        older = (12 * b - 4 * rc) / 8.0
        vals = [b] * (weeks - 12) + [older] * 8 + [rc] * 4
        hist = r.get("history")
        if hist is not None:
            vals = [np.nan] * (weeks - hist) + vals[weeks - hist:]
        series[r["sku_id"]] = vals
        skus.append({
            "sku_id": r["sku_id"], "sku_name": "Test " + r["sku_id"], "category": "Test",
            "perishable": r.get("perishable", False), "distributor_id": "DIST001",
            "standard_qty": r.get("std", 300), "stock": r["stock"], "on_order": np.nan,
            "unit_price": np.nan, "filled_weeks": r.get("filled", 0)})
    weekly = pd.DataFrame(series, index=cols).T
    weekly.index.name = "sku_id"
    return PlanningData(sku=pd.DataFrame(skus), weekly=weekly, festival_active=festival,
                        as_of=last.date() + pd.Timedelta(days=7), last_week_start=last, dist_weekly=dist)


@pytest.fixture
def mk():
    return make_data
