"""Trigger stage: twice-a-week schedule (config/app.yaml). Also see `python -m freshroots run`."""
from __future__ import annotations

import logging

from freshroots.config import Config
from freshroots.pipeline import run_pipeline

log = logging.getLogger("freshroots.scheduler")


def scheduled_job(cfg: Config, use_ai: bool = True):
    res = run_pipeline(cfg, use_ai=use_ai, trigger="scheduled", user="scheduler")
    log.info("Scheduled run %s: %s", res["run_id"], res["status"])
    return res


def start(cfg: Config, use_ai: bool = True) -> None:  # pragma: no cover - long-running
    from apscheduler.schedulers.blocking import BlockingScheduler
    from apscheduler.triggers.cron import CronTrigger
    s = cfg.app["schedule"]
    trigger = CronTrigger(day_of_week=s["day_of_week"], hour=s["hour"], minute=s["minute"], timezone=s["timezone"])
    sched = BlockingScheduler(timezone=s["timezone"])
    sched.add_job(scheduled_job, trigger, args=[cfg, use_ai], id="freshroots_run")
    print("Scheduler running: %s at %02d:%02d %s" % (s["day_of_week"], s["hour"], s["minute"], s["timezone"]))
    sched.start()
