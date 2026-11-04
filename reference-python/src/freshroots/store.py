"""SQLite store and audit log (plain sqlite3). One short-lived connection per call."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs(
  run_id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT, status TEXT,
  trigger TEXT, as_of TEXT, last_week TEXT, festival_active INTEGER, user TEXT, use_ai INTEGER,
  duration_seconds REAL, n_recs INTEGER DEFAULT 0, n_exceptions INTEGER DEFAULT 0,
  sales_age_days INTEGER, inventory_age_days INTEGER, message TEXT, fallbacks TEXT, params TEXT);
CREATE TABLE IF NOT EXISTS data_quality_issues(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, severity TEXT, code TEXT, count INTEGER,
  detail TEXT, sku_id TEXT);
CREATE TABLE IF NOT EXISTS recommendations(
  rec_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, rank INTEGER, sku_id TEXT, sku_name TEXT,
  category TEXT, perishable INTEGER, distributor_id TEXT, stock REAL, standard_qty REAL,
  baseline_avg_weekly REAL, recent_avg_weekly REAL, effective_avg_weekly REAL, festival_active INTEGER,
  cover_weeks REAL, recent_vs_baseline_pct REAL, flags TEXT, action TEXT, qty_multiplier REAL,
  recommended_qty REAL, final_qty REAL, qty_capped INTEGER, priority TEXT, value_at_risk REAL,
  value_unit TEXT, exception_codes TEXT, review_before_approving INTEGER, reasons TEXT, fallbacks TEXT,
  status TEXT DEFAULT 'PENDING', ai_status TEXT, ai_forecast TEXT, ai_confidence TEXT,
  ai_explanation TEXT, ai_unusual TEXT, ai_check TEXT, stat_forecast_weekly REAL, forecast_disagrees INTEGER,
  series TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_rec_run ON recommendations(run_id);
CREATE TABLE IF NOT EXISTS exceptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, sku_id TEXT, code TEXT, blocking INTEGER,
  detail TEXT);
CREATE TABLE IF NOT EXISTS ai_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, ts TEXT, batch INTEGER, attempt INTEGER,
  model TEXT, prompt TEXT, response TEXT, status TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS decisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, rec_id INTEGER, run_id INTEGER, sku_id TEXT, ts TEXT, user TEXT,
  decision TEXT, original_qty REAL, final_qty REAL, reason_code TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS po_drafts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, po_number TEXT UNIQUE, rec_id INTEGER, run_id INTEGER, sku_id TEXT,
  ts TEXT, user TEXT, quantity REAL, client TEXT, file_path TEXT, payload TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS kill_switch_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user TEXT, engaged INTEGER, reason TEXT);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user TEXT, event_type TEXT, entity_type TEXT,
  entity_id TEXT, run_id INTEGER, details TEXT);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self):
        c = sqlite3.connect(str(self.path), timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        try:
            yield c
            c.commit()
        finally:
            c.close()

    def query(self, sql: str, params: Iterable = ()) -> List[Dict[str, Any]]:
        with self.conn() as c:
            return [dict(r) for r in c.execute(sql, tuple(params)).fetchall()]

    def one(self, sql: str, params: Iterable = ()) -> Optional[Dict[str, Any]]:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Iterable = ()) -> int:
        with self.conn() as c:
            return c.execute(sql, tuple(params)).lastrowid

    def audit(self, user: str, event_type: str, entity_type: str = "", entity_id: Any = "",
              run_id: Optional[int] = None, details: Optional[dict] = None, conn=None) -> None:
        row = (now(), user, event_type, entity_type, str(entity_id), run_id, json.dumps(details or {}, default=str))
        sql = "INSERT INTO audit_log(ts,user,event_type,entity_type,entity_id,run_id,details) VALUES(?,?,?,?,?,?,?)"
        if conn is not None:
            conn.execute(sql, row)
        else:
            self.execute(sql, row)

    # ---------------------------------------------------------------- queries
    def latest_run(self, status: str = "SUCCESS") -> Optional[Dict[str, Any]]:
        return self.one("SELECT * FROM runs WHERE status=? ORDER BY run_id DESC LIMIT 1", (status,))

    def recommendations(self, run_id: int) -> List[Dict[str, Any]]:
        return self.query("SELECT * FROM recommendations WHERE run_id=? ORDER BY rank", (run_id,))
