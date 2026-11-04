"""Global kill switch. State is the latest row in kill_switch_events, so it survives restarts."""
from __future__ import annotations

from freshroots.store import Store, now


class KillSwitchEngaged(Exception):
    pass


def is_engaged(store: Store) -> bool:
    row = store.one("SELECT engaged FROM kill_switch_events ORDER BY id DESC LIMIT 1")
    return bool(row and row["engaged"])


def state(store: Store) -> dict:
    row = store.one("SELECT * FROM kill_switch_events ORDER BY id DESC LIMIT 1")
    return {"engaged": bool(row and row["engaged"]), "since": row["ts"] if row else None,
            "by": row["user"] if row else None, "reason": row["reason"] if row else None}


def set_engaged(store: Store, engaged: bool, user: str, reason: str = "") -> None:
    store.execute("INSERT INTO kill_switch_events(ts,user,engaged,reason) VALUES(?,?,?,?)",
                  (now(), user, int(engaged), reason))
    store.audit(user, "KILL_SWITCH_ON" if engaged else "KILL_SWITCH_OFF", "kill_switch", "global",
                details={"reason": reason})


def require_off(store: Store, what: str) -> None:
    if is_engaged(store):
        raise KillSwitchEngaged("Kill switch is engaged: %s blocked" % what)
