// Human control: approve, reject, edit quantity. Every action is audited.
import type { Db } from "./db";
import { isEngaged } from "./killswitch";
import { createPoDraft, type PurchaseOrderClient } from "./po";
import { auditStmt, now } from "./store";

export const REASON_CODES = ["market_knowledge", "supplier_issue", "already_ordered", "data_wrong", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export class DecisionError extends Error {}

type Rec = { rec_id: number; run_id: number; sku_id: string; action: string; status: string; recommended_qty: number; final_qty: number | null };
const getRec = async (db: Db, id: number) => {
  const r = (await db.query<Rec>("SELECT * FROM recommendations WHERE rec_id=$1", [id]))[0];
  if (!r) throw new DecisionError(`Unknown recommendation ${id}`);
  return r;
};
const checkReason = (c: unknown) => { if (!REASON_CODES.includes(c as ReasonCode)) throw new DecisionError(`A reason code is required: one of ${REASON_CODES.join(", ")}`); };

/** Approve rows. PO drafts are created unless the kill switch is engaged (the approval is still recorded). */
export async function approve(db: Db, recIds: number[], actor: string, client: PurchaseOrderClient): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (const id of recIds) {
    const rec = await getRec(db, id);
    if (rec.status !== "PENDING") throw new DecisionError(`Recommendation ${id} is ${rec.status}, cannot approve`);
    if (["EXCEPTION", "NO_ACTION"].includes(rec.action)) throw new DecisionError(`${rec.sku_id} has no rule action to approve (${rec.action})`);
    const qty = rec.final_qty ?? rec.recommended_qty;
    await db.batch([
      { text: "UPDATE recommendations SET status='APPROVED', final_qty=$2, updated_at=$3 WHERE rec_id=$1 AND status='PENDING'", params: [id, qty, now()] },
      { text: "INSERT INTO decisions(rec_id,run_id,sku_id,ts,actor,decision,original_qty,final_qty) VALUES($1,$2,$3,$4,$5,'APPROVE',$6,$7)", params: [id, rec.run_id, rec.sku_id, now(), actor, rec.recommended_qty, qty] },
      auditStmt(actor, "APPROVE", "recommendation", id, rec.run_id, { sku: rec.sku_id, action: rec.action, qty }),
    ]);
    out.push((await isEngaged(db)) ? null : await createPoDraft(db, id, client, actor));
  }
  return out;
}

/** Create drafts for rows approved while the kill switch was on. */
export async function createPendingPoDrafts(db: Db, actor: string, client: PurchaseOrderClient): Promise<string[]> {
  const made: string[] = [];
  for (const r of await db.query<{ rec_id: number }>("SELECT rec_id FROM recommendations WHERE status='APPROVED' ORDER BY rec_id")) {
    const po = await createPoDraft(db, r.rec_id, client, actor);
    if (po) made.push(po);
  }
  return made;
}

export async function reject(db: Db, recIds: number[], actor: string, reasonCode: string, note = "") {
  checkReason(reasonCode);
  for (const id of recIds) {
    const rec = await getRec(db, id);
    if (rec.status !== "PENDING") throw new DecisionError(`Recommendation ${id} is ${rec.status}, cannot reject`);
    await db.batch([
      { text: "UPDATE recommendations SET status='REJECTED', updated_at=$2 WHERE rec_id=$1 AND status='PENDING'", params: [id, now()] },
      { text: "INSERT INTO decisions(rec_id,run_id,sku_id,ts,actor,decision,original_qty,final_qty,reason_code,note) VALUES($1,$2,$3,$4,$5,'REJECT',$6,NULL,$7,$8)", params: [id, rec.run_id, rec.sku_id, now(), actor, rec.recommended_qty, reasonCode, note] },
      auditStmt(actor, "REJECT", "recommendation", id, rec.run_id, { sku: rec.sku_id, reason_code: reasonCode, note }),
    ]);
  }
}

export async function editQuantity(db: Db, recId: number, newQty: number, actor: string, reasonCode: string, note = "") {
  checkReason(reasonCode);
  const rec = await getRec(db, recId);
  if (rec.status !== "PENDING") throw new DecisionError(`Recommendation ${recId} is ${rec.status}, cannot edit`);
  if (!Number.isFinite(newQty) || newQty < 0) throw new DecisionError("Quantity must be a non-negative number");
  await db.batch([
    { text: "UPDATE recommendations SET final_qty=$2, updated_at=$3 WHERE rec_id=$1", params: [recId, newQty, now()] },
    { text: "INSERT INTO decisions(rec_id,run_id,sku_id,ts,actor,decision,original_qty,final_qty,reason_code,note) VALUES($1,$2,$3,$4,$5,'EDIT',$6,$7,$8,$9)", params: [recId, rec.run_id, rec.sku_id, now(), actor, rec.recommended_qty, newQty, reasonCode, note] },
    auditStmt(actor, "EDIT_QUANTITY", "recommendation", recId, rec.run_id, { sku: rec.sku_id, from: rec.recommended_qty, to: newQty, reason_code: reasonCode, note }),
  ]);
}
