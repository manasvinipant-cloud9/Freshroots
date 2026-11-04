from __future__ import annotations

import argparse
import json
import sys
from datetime import date

from dotenv import load_dotenv

from freshroots import killswitch
from freshroots.config import ROOT, load_config
from freshroots.pipeline import default_user, run_pipeline
from freshroots.store import Store


def main(argv=None) -> int:
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser(prog="freshroots")
    ap.add_argument("--db", help="override SQLite path")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run the pipeline once")
    r.add_argument("--as-of", help="YYYY-MM-DD (default: inventory As_Of_Date)")
    r.add_argument("--no-ai", action="store_true", help="rules only, no Gemini")
    r.add_argument("--data-dir")
    r.add_argument("--user")
    s = sub.add_parser("schedule", help="start the twice-weekly scheduler")
    s.add_argument("--no-ai", action="store_true")
    k = sub.add_parser("kill-switch", help="engage / release / show the kill switch")
    k.add_argument("state", choices=["on", "off", "status"])
    k.add_argument("--reason", default="")
    k.add_argument("--user")
    sub.add_parser("audit", help="print recent audit log").add_argument("-n", type=int, default=30)
    a = ap.parse_args(argv)

    cfg = load_config(data_dir=getattr(a, "data_dir", None), db_path=a.db)
    store = Store(cfg.db_path)
    if a.cmd == "run":
        as_of = date.fromisoformat(a.as_of) if a.as_of else None
        res = run_pipeline(cfg, store, as_of=as_of, use_ai=not a.no_ai, trigger="manual", user=a.user or default_user())
        print("Run %(run_id)s: %(status)s. %(message)s" % res)
        if res["status"] == "SUCCESS":
            rows = store.query("SELECT priority,sku_id,sku_name,action,recommended_qty,cover_weeks,recent_vs_baseline_pct,"
                               "flags FROM recommendations WHERE run_id=? AND action!='NO_ACTION' ORDER BY rank LIMIT 40",
                               (res["run_id"],))
            for x in rows:
                print("  %-3s %-8s %-30s %-20s qty=%-6s cover=%s  %+.1f%%  %s" % (
                    x["priority"], x["sku_id"], (x["sku_name"] or "")[:30], x["action"], int(x["recommended_qty"] or 0),
                    "n/a" if x["cover_weeks"] is None else "%.2f" % x["cover_weeks"],
                    x["recent_vs_baseline_pct"] or 0.0, x["flags"]))
            fb = json.loads(store.one("SELECT fallbacks FROM runs WHERE run_id=?", (res["run_id"],))["fallbacks"])
            print("Fallbacks used:", ", ".join(fb))
        return 0 if res["status"] in ("SUCCESS", "SKIPPED_KILL_SWITCH") else 1
    if a.cmd == "schedule":
        from freshroots.scheduler import start
        start(cfg, use_ai=not a.no_ai)
    elif a.cmd == "kill-switch":
        if a.state == "status":
            print(killswitch.state(store))
        else:
            killswitch.set_engaged(store, a.state == "on", a.user or default_user(), a.reason)
            print(killswitch.state(store))
    elif a.cmd == "audit":
        for e in store.query("SELECT ts,user,event_type,entity_type,entity_id,details FROM audit_log ORDER BY id DESC LIMIT ?", (a.n,)):
            print(e["ts"], e["user"], e["event_type"], e["entity_type"], e["entity_id"], e["details"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
