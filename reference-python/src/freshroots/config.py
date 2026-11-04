"""Load YAML config. Unknown keys fail loudly; nothing is guessed."""
from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import yaml

ROOT = Path(os.environ.get("FRESHROOTS_ROOT", Path(__file__).resolve().parents[2]))


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class RulesParams:
    recent_window_weeks: int = 4
    baseline_window_weeks: int = 12
    high_demand_threshold_pct: float = 20.0
    high_demand_reorder_multiplier: float = 1.5
    stockout_cover_weeks: float = 6.0
    overstock_cover_weeks: float = 14.0
    perishable_min_cover_weeks: float = 3.0
    perishable_max_cover_weeks: float = 4.0
    festival_months: Tuple[int, ...] = (10, 11, 3)
    festival_uplift_pct: float = 25.0
    festival_uplift_applies_to_r1_baseline: bool = False
    min_history_weeks: int = 12
    max_data_age_days: int = 10
    distributor_anomaly_z: float = 2.5
    distributor_anomaly_drop_pct: float = 40.0
    distributor_anomaly_min_avg_units: float = 10.0
    distributor_anomaly_min_history_weeks: int = 8
    sku_wow_spike_pct: float = 50.0
    target_cover_weeks: float = 8.0
    perishable_target_cover_weeks: float = 3.5
    max_missing_inventory_pct: float = 20.0
    max_filled_weeks: int = 2

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RulesParams":
        known = {f.name for f in fields(cls)}
        unknown = set(d) - known
        if unknown:
            raise ConfigError("Unknown keys in rules.yaml: %s" % sorted(unknown))
        d = dict(d)
        if "festival_months" in d:
            d["festival_months"] = tuple(int(m) for m in d["festival_months"])
        return cls(**d)


@dataclass
class Config:
    rules: RulesParams
    schema_map: Dict[str, Any]
    app: Dict[str, Any]
    root: Path = ROOT
    data_dir: Path = field(default=None)  # type: ignore
    db_path: Path = field(default=None)  # type: ignore
    po_drafts_dir: Path = field(default=None)  # type: ignore

    def resolve(self, p: str) -> Path:
        path = Path(p)
        return path if path.is_absolute() else self.root / path


def _read(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise ConfigError("Missing config file: %s" % path)
    return yaml.safe_load(path.read_text()) or {}


def load_config(
    config_dir: Optional[Path] = None,
    data_dir: Optional[str] = None,
    db_path: Optional[str] = None,
    rules_overrides: Optional[Dict[str, Any]] = None,
) -> Config:
    cdir = Path(config_dir) if config_dir else ROOT / "config"
    rules_raw = _read(cdir / "rules.yaml")
    rules_raw.update(rules_overrides or {})
    cfg = Config(
        rules=RulesParams.from_dict(rules_raw),
        schema_map=_read(cdir / "schema_map.yaml"),
        app=_read(cdir / "app.yaml"),
    )
    paths = cfg.app["paths"]
    cfg.data_dir = cfg.resolve(data_dir or paths["data_dir"])
    cfg.db_path = cfg.resolve(db_path or paths["db_path"])
    cfg.po_drafts_dir = cfg.resolve(paths["po_drafts_dir"])
    return cfg
