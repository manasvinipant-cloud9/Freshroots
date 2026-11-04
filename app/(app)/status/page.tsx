import { Download } from "lucide-react";
import { CreatePending } from "@/components/Actions";
import { Badge, Card, Stat } from "@/components/ui";
import { getDb } from "@/lib/db";
import { killState } from "@/lib/killswitch";
import { approvedWithoutPo, lifecycle, poDrafts, statusCounts } from "@/lib/queries";
import { ACTION_LABEL, when } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Page() {
  const db = getDb();
  const [counts, life, pos, held, kill] = await Promise.all([statusCounts(db), lifecycle(db), poDrafts(db), approvedWithoutPo(db), killState(db)]);
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[20px] font-semibold">Status and purchase orders</h1>
        <p className="mt-1 text-[13px] text-ink-3">Lifecycle: PENDING, then APPROVED, then PO_DRAFTED, or REJECTED. Nothing is ever sent to Zoho automatically; drafts hold the exact payload a Zoho Inventory PO needs.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {["PENDING", "APPROVED", "PO_DRAFTED", "REJECTED", "SUPERSEDED"].map((s) => <Stat key={s} label={s.replace("_", " ")} value={n(s)} />)}
      </div>
      {held > 0 && <CreatePending count={held} killEngaged={kill.engaged} />}
      <Card title="PO drafts">
        {pos.length ? (
          <table className="w-full text-left text-[12.5px]"><thead className="text-[11.5px] uppercase text-ink-4"><tr><th className="py-1">PO number</th><th>SKU</th><th className="text-right">Qty</th><th>Client</th><th>By</th><th>Created</th><th /></tr></thead>
            <tbody>{pos.map((p) => (
              <tr key={p.po_number} className="border-t border-line-soft align-top">
                <td className="py-2 font-mono">{p.po_number}</td><td>{p.sku_id}</td><td className="tnum text-right">{p.quantity}</td><td><Badge>{p.client}</Badge></td><td>{p.actor}</td><td>{when(p.ts)}</td>
                <td className="text-right"><a className="inline-flex items-center gap-1 text-accent underline underline-offset-2" href={`/api/po-drafts/${p.po_number}`}><Download size={12} /> payload</a></td>
              </tr>))}</tbody></table>
        ) : <p className="text-[13px] text-ink-3">No PO drafts yet. Approve a reorder recommendation to create one.</p>}
      </Card>
      <Card title="Every recommendation (latest 300)">
        <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-[12.5px]"><thead className="text-[11.5px] uppercase text-ink-4"><tr><th className="py-1">Run</th><th>SKU</th><th>Action</th><th className="text-right">Rules qty</th><th className="text-right">Final qty</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>{life.map((r: any) => <tr key={r.rec_id} className="border-t border-line-soft"><td className="py-1.5">{r.run_id}</td><td>{r.sku_id} <span className="text-ink-4">{r.sku_name}</span></td><td>{ACTION_LABEL[r.action]}</td><td className="tnum text-right">{r.recommended_qty}</td><td className="tnum text-right">{r.final_qty ?? "-"}</td><td><Badge tone={r.status === "PO_DRAFTED" ? "good" : r.status === "REJECTED" ? "bad" : "neutral"}>{r.status}</Badge></td><td>{when(r.updated_at)}</td></tr>)}</tbody></table></div>
      </Card>
    </div>
  );
}
