"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Btn, Label, Modal, field, cn } from "./ui";
import { post } from "@/lib/client";
import { when } from "@/lib/format";
import type { KillState } from "@/lib/killswitch";

/** Always visible in the header, with its current state. Engaging it halts runs and PO creation; the dashboard stays viewable. */
export default function KillSwitch({ state }: { state: KillState }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try { await post("/api/kill-switch", { engaged: !state.engaged, reason }); setOpen(false); setReason(""); router.refresh(); } finally { setBusy(false); }
  };
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label={`Kill switch is ${state.engaged ? "engaged" : "off"}`}
        className={cn("flex h-8 items-center gap-2 rounded-lg border px-3 text-[13px] font-semibold", state.engaged ? "border-bad bg-bad-bg text-bad" : "border-line-ctl bg-panel text-good")}>
        {state.engaged ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
        {state.engaged ? "KILL SWITCH ENGAGED" : "Kill switch: off"}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={state.engaged ? "Release the kill switch?" : "Engage the kill switch?"}>
        {state.engaged ? (
          <p className="text-[13px] text-ink-2">Engaged {when(state.since)} by {state.by}{state.reason ? `: "${state.reason}"` : ""}. Releasing lets runs and PO drafts proceed again.</p>
        ) : (
          <p className="text-[13px] text-ink-2">This halts scheduled and manual runs and blocks all purchase order creation. Approvals are still recorded, and the dashboard stays viewable.</p>
        )}
        <Label>Reason (optional)</Label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={field} placeholder="e.g. supplier data under review" />
        <div className="mt-4 flex justify-end gap-2">
          <Btn onClick={() => setOpen(false)}>Cancel</Btn>
          <Btn variant={state.engaged ? "primary" : "danger"} disabled={busy} onClick={toggle}>{state.engaged ? "Release" : "Engage now"}</Btn>
        </div>
      </Modal>
    </>
  );
}
