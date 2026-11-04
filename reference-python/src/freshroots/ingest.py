"""Input stage: load SAP exports behind a DataSource interface.

Raw columns are renamed to logical names using config/schema_map.yaml. A missing
required column raises SchemaError (the run then FAILS); we never guess.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict

import pandas as pd


class SchemaError(Exception):
    """A required file or column from schema_map.yaml is missing."""


class DataSource(ABC):
    @abstractmethod
    def load(self) -> Dict[str, pd.DataFrame]:
        """Return {file_key: DataFrame with logical column names}."""


class CsvDataSource(DataSource):
    def __init__(self, data_dir: Path, schema_map: Dict[str, Any]):
        self.data_dir = Path(data_dir)
        self.files = schema_map["files"]

    def load(self) -> Dict[str, pd.DataFrame]:
        out: Dict[str, pd.DataFrame] = {}
        for key, spec in self.files.items():
            path = self.data_dir / spec["file"]
            if not path.exists():
                raise SchemaError("Required file missing: %s" % path)
            df = pd.read_csv(path, dtype=str, keep_default_na=False)
            df.columns = [c.strip() for c in df.columns]
            missing = [real for real in spec["required"].values() if real not in df.columns]
            if missing:
                raise SchemaError(
                    "%s is missing required column(s) %s (found %s)"
                    % (spec["file"], missing, list(df.columns))
                )
            rename = {real: logical for logical, real in spec["required"].items()}
            for logical, real in (spec.get("optional") or {}).items():
                if real in df.columns:
                    rename[real] = logical
            keep = list(rename)
            out[key] = df[keep].rename(columns=rename)
        return out
