import { route, actorOf } from "@/lib/api";
import { approve, createPendingPoDrafts, editQuantity, reject, DecisionError } from "@/lib/decisions";
import { getPoClient } from "@/lib/po";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = route(async (db, req) => {
  const b = await req.json();
  const actor = actorOf(b);
  const ids: number[] = (b.recIds ?? []).map(Number);
  if (b.action !== "create_pending" && !ids.length) throw new DecisionError("No rows selected");
  switch (b.action) {
    case "approve": { const pos = await approve(db, ids, actor, getPoClient()); return { approved: ids.length, po_drafts: pos.filter(Boolean) }; }
    case "reject": await reject(db, ids, actor, b.reasonCode, b.note ?? ""); return { rejected: ids.length };
    case "edit": await editQuantity(db, ids[0], Number(b.qty), actor, b.reasonCode, b.note ?? ""); return { edited: ids[0] };
    case "create_pending": return { po_drafts: await createPendingPoDrafts(db, actor, getPoClient()) };
    default: throw new DecisionError("Unknown action");
  }
});
