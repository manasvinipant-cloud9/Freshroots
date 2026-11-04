"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Btn } from "./ui";
import { getActor, post } from "@/lib/client";

export function CreatePending({ count, killEngaged }: { count: number; killEngaged: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-warn-line/50 bg-warn-bg p-3 text-[13px] text-warn">
      <span>{count} approved reorder{count === 1 ? "" : "s"} still need a PO draft{killEngaged ? " (the kill switch is holding them back)" : ""}.</span>
      <Btn disabled={killEngaged || busy} onClick={async () => { setBusy(true); try { const r = await post("/api/decisions", { action: "create_pending" }); setMsg(`Created ${r.po_drafts.length} draft(s)`); router.refresh(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } }}>Create PO drafts</Btn>
      {msg && <span>{msg}</span>}
    </div>
  );
}

const FILES = ["sku_master.csv", "weekly_sales.csv", "current_inventory.csv", "distributor_master.csv", "calendar.csv"];

export function UploadForm({ uploaded }: { uploaded: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function send(fd: FormData, ok: string) {
    setBusy(true); setMsg(null);
    fd.append("actor", getActor());
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `Upload failed (${r.status})`);
      setMsg({ ok: true, text: ok }); router.refresh();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); send(new FormData(e.currentTarget), "Uploaded. The next run uses these exports."); }} className="space-y-2">
      <p className="text-[12.5px] text-ink-3">Upload all five SAP exports together. Columns are checked against the schema map first; a missing column is rejected by name. Max 4 MB per file.</p>
      <div className="grid gap-2 md:grid-cols-2">{FILES.map((f) => <label key={f} className="flex items-center justify-between gap-2 rounded-lg bg-sunken px-3 py-2 text-[12.5px]"><span className="font-mono text-ink-2">{f}</span><input type="file" name={f} accept=".csv" required className="max-w-[55%] text-[12px]" /></label>)}</div>
      <div className="flex gap-2"><Btn variant="primary" type="submit" disabled={busy}>Upload set</Btn>
        {uploaded && <Btn type="button" disabled={busy} onClick={() => { const fd = new FormData(); fd.append("reset", "1"); send(fd, "Back to the bundled seed data."); }}>Use bundled seed data instead</Btn>}</div>
      {msg && <p className={`rounded-lg p-2 text-[12.5px] ${msg.ok ? "bg-good-bg text-good" : "bg-bad-bg text-bad"}`}>{msg.text}</p>}
    </form>
  );
}
