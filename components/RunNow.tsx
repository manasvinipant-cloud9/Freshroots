"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { Btn, Label, Modal, field } from "./ui";
import { post } from "@/lib/client";

export default function RunNow({ killEngaged }: { killEngaged: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [asOf, setAsOf] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await post("/api/run", { asOf: asOf || null, useAi });
      setMsg({ ok: r.status === "SUCCESS", text: `Run ${r.run_id}: ${r.status}. ${r.message}` });
      router.refresh();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <>
      <Btn variant="primary" onClick={() => { setOpen(true); setMsg(null); }} title={killEngaged ? "Kill switch is on: the run will be skipped" : undefined}><Play size={13} /> Run now</Btn>
      <Modal open={open} onClose={() => setOpen(false)} title="Run the pipeline now">
        <p className="text-[13px] text-ink-2">Runs the same analysis as the twice-weekly schedule. Nothing becomes a purchase order until you approve it.</p>
        <Label>As-of date (blank = the inventory date)</Label>
        <input value={asOf} onChange={(e) => setAsOf(e.target.value)} placeholder="YYYY-MM-DD" className={field} />
        <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> Use Gemini for forecasts and explanations</label>
        {killEngaged && <p className="mt-3 rounded-lg bg-bad-bg p-2 text-[12.5px] text-bad">The kill switch is on, so this run will be skipped.</p>}
        {msg && <p className={`mt-3 rounded-lg p-2 text-[12.5px] ${msg.ok ? "bg-good-bg text-good" : "bg-warn-bg text-warn"}`}>{msg.text}</p>}
        <div className="mt-4 flex justify-end gap-2"><Btn onClick={() => setOpen(false)}>Close</Btn><Btn variant="primary" disabled={busy} onClick={go}>{busy ? "Running..." : "Run"}</Btn></div>
      </Modal>
    </>
  );
}
