"""Human control: approve, reject, edit quantity. Every action is audited."""
from __future__ import annotations

from typing import Iterable, List, Optional

from freshroots import killswitch
from freshroots.po import PurchaseOrderClient, create_po_draft
from freshroots.store import Store, now

REASON_CODES = ("market_knowledge", "supplier_issue", "already_ordered", "data_wrong", "other")
OPEN_STATUSES = ("PENDING",)


class DecisionError(Exception):
    pass


def _rec(store: Store, rec_id: int) -> dict:
    rec = store.one("SELECT * FROM recommendations WHERE rec_id=?", (rec_id,))
    if rec is None:
        raise DecisionError("Unknown recommendation %s" % rec_id)
    return rec


def _check_reason(reason_code: Optional[str]) -> None:
    if reason_code not in REASON_CODES:
        raise DecisionError("A reason code is required: one of %s" % (REASON_CODES,))


def approve(store: Store, rec_ids: Iterable[int], user: str, client: PurchaseOrderClient) -> List[Optional[str]]:
    """Approve rows. PO drafts are created unless the kill switch is engaged
    (the approval is still recorded; drafts can be created once it is released)."""
    out: List[Optional[str]] = []
    for rec_id in rec_ids:
        rec = _rec(store, rec_id)
        if rec["status"] not in OPEN_STATUSES:
            raise DecisionError("Recommendation %s is %s, cannot approve" % (rec_id, rec["status"]))
        if rec["action"] in ("EXCEPTION", "NO_ACTION"):
            raise DecisionError("%s has no rule action to approve (%s)" % (rec["sku_id"], rec["action"]))
        qty = rec["final_qty"] if rec["final_qty"] is not None else rec["recommended_qty"]
        with store.conn() as c:
            c.execute("UPDATE recommendations SET status='APPROVED', final_qty=?, updated_at=? WHERE rec_id=?",
                      (qty, now(), rec_id))
            c.execute("INSERT INTO decisions(rec_id,run_id,sku_id,ts,user,decision,original_qty,final_qty)"
                      " VALUES(?,?,?,?,?,?,?,?)",
                      (rec_id, rec["run_id"], rec["sku_id"], now(), user, "APPROVE", rec["recommended_qty"], qty))
            store.audit(user, "APPROVE", "recommendation", rec_id, rec["run_id"],
                        {"sku": rec["sku_id"], "action": rec["action"], "qty": qty}, conn=c)
        out.append(None if killswitch.is_engaged(store) else create_po_draft(store, rec_id, client, user))
    return out


def create_pending_po_drafts(store: Store, user: str, client: PurchaseOrderClient) -> List[str]:
    """Create drafts for rows approved while the kill switch was on."""
    made = []
    for r in store.query("SELECT rec_id FROM recommendations WHERE status='APPROVED'"):
        po = create_po_draft(store, r["rec_id"], client, user)
        if po:
            made.append(po)
    return made


def reject(store: Store, rec_ids: Iterable[int], user: str, reason_code: str, note: str = "") -> None:
    _check_reason(reason_code)
    for rec_id in rec_ids:
        rec = _rec(store, rec_id)
        if rec["status"] not in OPEN_STATUSES:
            raise DecisionError("Recommendation %s is %s, cannot reject" % (rec_id, rec["status"]))
        with store.conn() as c:
            c.execute("UPDATE recommendations SET status='REJECTED', updated_at=? WHERE rec_id=?", (now(), rec_id))
            c.execute("INSERT INTO decisions(rec_id,run_id,sku_id,ts,user,decision,original_qty,final_qty,reason_code,note)"
                      " VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (rec_id, rec["run_id"], rec["sku_id"], now(), user, "REJECT", rec["recommended_qty"], None,
                       reason_code, note))
            store.audit(user, "REJECT", "recommendation", rec_id, rec["run_id"],
                        {"sku": rec["sku_id"], "reason_code": reason_code, "note": note}, conn=c)


def edit_quantity(store: Store, rec_id: int, new_qty: float, user: str, reason_code: str, note: str = "") -> None:
    _check_reason(reason_code)
    rec = _rec(store, rec_id)
    if rec["status"] not in OPEN_STATUSES:
        raise DecisionError("Recommendation %s is %s, cannot edit" % (rec_id, rec["status"]))
    if new_qty < 0:
        raise DecisionError("Quantity cannot be negative")
    with store.conn() as c:
        c.execute("UPDATE recommendations SET final_qty=?, updated_at=? WHERE rec_id=?", (new_qty, now(), rec_id))
        c.execute("INSERT INTO decisions(rec_id,run_id,sku_id,ts,user,decision,original_qty,final_qty,reason_code,note)"
                  " VALUES(?,?,?,?,?,?,?,?,?,?)",
                  (rec_id, rec["run_id"], rec["sku_id"], now(), user, "EDIT", rec["recommended_qty"], new_qty,
                   reason_code, note))
        store.audit(user, "EDIT_QUANTITY", "recommendation", rec_id, rec["run_id"],
                    {"sku": rec["sku_id"], "from": rec["recommended_qty"], "to": new_qty,
                     "reason_code": reason_code, "note": note}, conn=c)
