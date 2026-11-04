"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Pencil, X } from "lucide-react";
import { Badge, Btn, Label, Modal, Spark, cn, field, type Tone } from "./ui";
import { post } from "@/lib/client";
import { ACTION_LABEL, EXC_HINT, FLAG_LABEL, REASON_LABEL, n1, signed } from "@/lib/format";
import type { ExcRow, RecRow } from "@/lib/queries";

const PRIO_TONE: Record<string, Tone> = { P1: "bad", P2: "warn", P3: "neutral", EX: "warn" };
const FLAG_TONE: Record<string, Tone> = { HIGH_DEMAND: "info", STOCKOUT_RISK: "bad", OVERSTOCK_RISK: "warn" };
const STATUS_TONE: Record<string, Tone> = { PENDING: "neutral", APPROVED: "info", PO_DRAFTED: "good", REJECTED: "bad", SUPERSEDED: "neutral" };
const decidable = (r: RecRow) => r.status === "PENDING" && !["EXCEPTION", "NO_ACTION"].includes(r.action);
const qtyOf = (r: RecRow) => r.final_qty ?? r.recommended_qty;

type Props = { rows: RecRow[]; excs: ExcRow[]; mode: "main" | "exceptions"; valueUnit: string };

export default function RecsTable({ rows, excs, mode, valueUnit }: Props) {
  const router = useRouter();
  const [flagSel, setFlagSel] = useState<string[]>([]);
  const [prioSel, setPrioSel] = useState<string[]>(mode === "main" ? ["P1", "P2", "EX"] : []);
  const [perish, setPerish] = useState<"all" | "yes" | "no">("all");
  const [excOnly, setExcOnly] = useState(false);
  const [showNoAction, setShowNoAction] = useState(false);
  const [codeSel, setCodeSel] = useState<string[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<RecRow | null>(null);
  const [dlg, setDlg] = useState<null | "reject" | "edit">(null);
  const [reason, setReason] = useState("market_knowledge");
  const [note, setNote] = useState("");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const excBySku = useMemo(() => { const m = new Map<string, ExcRow[]>(); excs.forEach((e) => m.set(e.sku_id, [...(m.get(e.sku_id) ?? []), e])); return m; }, [excs]);
  const allCodes = useMemo(() => [...new Set(excs.map((e) => e.code))].sort(), [excs]);

  const shown = useMemo(() => rows.filter((r) => {
    if (r.status === "SUPERSEDED") return false;
    if (mode === "exceptions") return r.exception_codes.length > 0 && (!codeSel.length || r.exception_codes.some((c) => codeSel.includes(c)));
    if (!showNoAction && r.action === "NO_ACTION") return false;
    if (!showNoAction && prioSel.length && !prioSel.includes(r.priority)) return false;
    if (flagSel.length && !r.flags.some((f) => flagSel.includes(f))) return false;
    if (perish !== "all" && r.perishable !== (perish === "yes")) return false;
    if (excOnly && !r.exception_codes.length) return false;
    return true;
  }), [rows, mode, codeSel, showNoAction, prioSel, flagSel, perish, excOnly]);

  const chosen = shown.filter((r) => sel.has(r.rec_id));
  const eligible = chosen.filter(decidable);
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const chip = (on: boolean) => cn("rounded-lg border px-2.5 py-1 text-[12px]", on ? "border-accent bg-raised text-ink" : "border-line-ctl text-ink-3 hover:bg-hover");
  const flip = (arr: string[], set: (v: string[]) => void, v: string) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  async function act(body: Record<string, unknown>, done: (r: any) => string) {
    setBusy(true); setToast(null);
    try { const r = await post("/api/decisions", body); setToast({ ok: true, text: done(r) }); setSel(new Set()); setDlg(null); setNote(""); router.refresh(); }
    catch (e) { setToast({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  const ids = eligible.map((r) => r.rec_id);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {mode === "main" ? (
          <>
            {["HIGH_DEMAND", "STOCKOUT_RISK", "OVERSTOCK_RISK"].map((f) => <button key={f} className={chip(flagSel.includes(f))} onClick={() => flip(flagSel, setFlagSel, f)}>{FLAG_LABEL[f]}</button>)}
            <span className="mx-1 h-5 w-px bg-line" />
            {["P1", "P2", "P3", "EX"].map((p) => <button key={p} className={chip(prioSel.includes(p))} onClick={() => flip(prioSel, setPrioSel, p)}>{p === "EX" ? "Exceptions" : p}</button>)}
            <select value={perish} onChange={(e) => setPerish(e.target.value as any)} className={cn(field, "w-auto")} aria-label="Perishable filter"><option value="all">All SKUs</option><option value="yes">Perishable only</option><option value="no">Non-perishable only</option></select>
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink-3"><input type="checkbox" checked={excOnly} onChange={(e) => setExcOnly(e.target.checked)} /> With exceptions</label>
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink-3"><input type="checkbox" checked={showNoAction} onChange={(e) => setShowNoAction(e.target.checked)} /> Show no-action SKUs</label>
          </>
        ) : allCodes.map((c) => <button key={c} className={chip(codeSel.includes(c))} onClick={() => flip(codeSel, setCodeSel, c)}>{c}</button>)}
        <span className="ml-auto text-[12px] text-ink-4">{shown.length} row{shown.length === 1 ? "" : "s"}</span>
      </div>

      {toast && <div role="status" className={cn("mb-3 rounded-lg p-2.5 text-[13px]", toast.ok ? "bg-good-bg text-good" : "bg-bad-bg text-bad")}>{toast.text}</div>}

      <div className="overflow-x-auto rounded-xl border border-line bg-panel shadow-card">
        <table className="w-full min-w-[1100px] text-left text-[12.5px]">
          <thead className="bg-thead text-[11.5px] uppercase tracking-wide text-ink-4">
            <tr>
              <th className="w-9 px-3 py-2"><input type="checkbox" aria-label="Select all" checked={shown.length > 0 && shown.every((r) => sel.has(r.rec_id))} onChange={(e) => setSel(e.target.checked ? new Set(shown.map((r) => r.rec_id)) : new Set())} /></th>
              <th className="px-2 py-2">Priority</th><th className="px-2">SKU</th>
              {mode === "main" ? <><th className="px-2">Flags</th><th className="px-2">Action</th><th className="px-2 text-right">Qty</th><th className="px-2 text-right">Cover (wks)</th><th className="px-2 text-right">Recent vs base</th></>
                : <><th className="px-2">Exception</th><th className="px-2">Detail</th><th className="px-2">Rule action</th><th className="px-2 text-right">Qty</th></>}
              <th className="px-2">Gemini 4-wk forecast</th>
              <th className="px-2">{mode === "main" ? "Explanation" : "What looks unusual / what to check"}</th><th className="px-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const es = excBySku.get(r.sku_id) ?? [];
              return (
                <tr key={r.rec_id} className={cn("border-t border-line-soft align-top hover:bg-hover", sel.has(r.rec_id) && "bg-raised/60")}>
                  <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${r.sku_id}`} checked={sel.has(r.rec_id)} onChange={() => toggle(r.rec_id)} /></td>
                  <td className="px-2 py-2">{r.priority ? <Badge tone={PRIO_TONE[r.priority]}>{r.priority}</Badge> : <span className="text-ink-4">-</span>}</td>
                  <td className="px-2 py-2">
                    <button onClick={() => setOpen(r)} className="block text-left"><span className="block font-semibold text-ink underline decoration-line decoration-1 underline-offset-2 hover:decoration-accent">{r.sku_id}</span>
                      <span className="block max-w-[210px] truncate text-ink-3">{r.sku_name}</span></button>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-4">{r.category}{r.perishable && <Badge tone="warn">Perishable</Badge>}</div>
                  </td>
                  {mode === "main" ? (
                    <>
                      <td className="px-2 py-2"><div className="flex max-w-[170px] flex-wrap gap-1">{r.flags.map((f) => <Badge key={f} tone={FLAG_TONE[f]}>{FLAG_LABEL[f]}</Badge>)}{r.exception_codes.map((c) => <Badge key={c} tone="warn">{c}</Badge>)}</div></td>
                      <td className="px-2 py-2"><div className="font-medium">{ACTION_LABEL[r.action]}</div>
                        {r.review_before_approving && <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-warn"><AlertTriangle size={11} /> Review before approving</div>}</td>
                      <td className="tnum px-2 py-2 text-right">{r.recommended_qty > 0 || r.final_qty !== null ? <>{qtyOf(r)}{r.final_qty !== null && r.final_qty !== r.recommended_qty && <div className="text-[11px] text-ink-4">was {r.recommended_qty}</div>}{r.qty_capped && <div className="text-[11px] text-warn">capped</div>}</> : "-"}</td>
                      <td className="tnum px-2 py-2 text-right">{n1(r.cover_weeks, 2)}</td>
                      <td className="tnum px-2 py-2 text-right">{signed(r.recent_vs_baseline_pct)}</td>
                    </>
                  ) : (
                    <>
                      <td className="px-2 py-2"><div className="flex flex-col gap-1">{es.map((e, i) => <Badge key={i} tone={e.blocking ? "bad" : "warn"} title={EXC_HINT[e.code]}>{e.code}</Badge>)}</div></td>
                      <td className="max-w-[260px] px-2 py-2 text-ink-2">{es.map((e, i) => <div key={i}>{e.detail}</div>)}</td>
                      <td className="px-2 py-2">{ACTION_LABEL[r.action]}{r.review_before_approving && <div className="text-[11.5px] text-warn">Review before approving</div>}</td>
                      <td className="tnum px-2 py-2 text-right">{r.recommended_qty > 0 ? qtyOf(r) : "-"}</td>
                    </>
                  )}
                  <td className="tnum px-2 py-2">{r.ai_forecast ? <>{r.ai_forecast.map((x) => Math.round(x)).join(", ")}{r.forecast_disagrees && <div className="mt-0.5"><Badge tone="warn" title={`Statistical baseline ${n1(r.stat_forecast_weekly, 0)}/wk`}>Disagrees with baseline</Badge></div>}</> : <span className="text-ink-4">-</span>}</td>
                  <td className="max-w-[300px] px-2 py-2 text-ink-2">
                    {mode === "main" ? (r.ai_status === "OK" ? r.ai_explanation : r.ai_status === "UNAVAILABLE" ? <span className="text-ink-4">AI note unavailable</span> : <span className="text-ink-4">-</span>)
                      : r.ai_status === "OK" ? <>{r.ai_unusual && <div>{r.ai_unusual}</div>}{r.ai_check && <div className="mt-1 text-ink-3">Check: {r.ai_check}</div>}{!r.ai_unusual && r.ai_explanation}</> : r.ai_status === "UNAVAILABLE" ? <span className="text-ink-4">AI note unavailable</span> : <span className="text-ink-4">-</span>}
                  </td>
                  <td className="px-2 py-2"><Badge tone={STATUS_TONE[r.status]}>{r.status.replace("_", " ")}</Badge></td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={12} className="px-4 py-10 text-center text-ink-3">{mode === "main" ? "Nothing matches these filters." : "No exceptions in this run."}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-ink-4">{valueUnit === "units" ? "Ranked by units of shortfall or excess because the data has no unit price." : "Ranked by rupee value at risk."} Perishables rank first within a priority tier.</p>

      {sel.size > 0 && (
        <div className="sticky bottom-4 z-20 mx-auto mt-4 flex max-w-3xl flex-wrap items-center gap-2 rounded-xl border border-line-ctl bg-panel p-3 shadow-card">
          <span className="text-[13px] text-ink-2">{sel.size} selected{eligible.length !== sel.size && ` (${eligible.length} can be decided)`}</span>
          <div className="ml-auto flex gap-2">
            <Btn variant="primary" disabled={busy || !eligible.length} onClick={() => act({ action: "approve", recIds: ids }, (r) => `Approved ${r.approved}. PO drafts created: ${r.po_drafts.length}${r.po_drafts.length < r.approved ? " (pauses need no PO, or the kill switch is holding drafts back)" : ""}`)}><Check size={14} /> Approve {eligible.length || ""}</Btn>
            <Btn disabled={busy || !eligible.length} onClick={() => setDlg("reject")}><X size={14} /> Reject</Btn>
            <Btn disabled={busy || eligible.length !== 1} onClick={() => { setQty(String(qtyOf(eligible[0]))); setDlg("edit"); }} title="Select exactly one row"><Pencil size={14} /> Edit quantity</Btn>
          </div>
        </div>
      )}

      <Modal open={dlg === "reject"} onClose={() => setDlg(null)} title={`Reject ${eligible.length} recommendation${eligible.length === 1 ? "" : "s"}`}>
        <Label>Reason code (required)</Label>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className={field}>{Object.entries(REASON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <Label>Note (optional)</Label><input value={note} onChange={(e) => setNote(e.target.value)} className={field} />
        <div className="mt-4 flex justify-end gap-2"><Btn onClick={() => setDlg(null)}>Cancel</Btn><Btn variant="danger" disabled={busy} onClick={() => act({ action: "reject", recIds: ids, reasonCode: reason, note }, (r) => `Rejected ${r.rejected}`)}>Reject</Btn></div>
      </Modal>
      <Modal open={dlg === "edit"} onClose={() => setDlg(null)} title={`Edit quantity: ${eligible[0]?.sku_id ?? ""}`}>
        <p className="text-[13px] text-ink-3">Rules recommended {eligible[0]?.recommended_qty}. Saving keeps the row pending; approve it afterwards to draft the PO at the new quantity.</p>
        <Label>New quantity</Label><input type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} className={field} />
        <Label>Reason code (required)</Label>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className={field}>{Object.entries(REASON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <Label>Note (optional)</Label><input value={note} onChange={(e) => setNote(e.target.value)} className={field} />
        <div className="mt-4 flex justify-end gap-2"><Btn onClick={() => setDlg(null)}>Cancel</Btn><Btn variant="primary" disabled={busy} onClick={() => act({ action: "edit", recIds: ids, qty: Number(qty), reasonCode: reason, note }, () => "Quantity saved. Approve the row to draft the PO.")}>Save</Btn></div>
      </Modal>

      {open && (
        <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-line bg-panel p-5 shadow-card" role="dialog" aria-label={`${open.sku_id} detail`}>
          <div className="flex items-start justify-between"><div><div className="text-[15px] font-semibold">{open.sku_id}</div><div className="text-[13px] text-ink-3">{open.sku_name}</div></div><button onClick={() => setOpen(null)} aria-label="Close" className="text-ink-3 hover:text-ink"><X size={16} /></button></div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[12.5px]">
            {[["Stock", open.stock], ["Weeks of cover", n1(open.cover_weeks, 2)], ["Baseline /wk", n1(open.baseline_avg_weekly, 1)], ["Effective /wk", n1(open.effective_avg_weekly, 1)], ["Recent /wk", n1(open.recent_avg_weekly, 1)], ["Recent vs base", signed(open.recent_vs_baseline_pct)]].map(([k, v]) => <div key={String(k)} className="rounded-lg bg-sunken p-2"><div className="text-ink-4">{k}</div><div className="tnum text-[14px] font-semibold">{String(v)}</div></div>)}
          </div>
          <div className="mt-3"><div className="mb-1 text-[12px] text-ink-4">Weekly units, last 16 weeks</div><Spark values={open.series} w={360} h={44} /></div>
          <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-4">Why (rule reasons)</h3>
          <div className="mt-1 space-y-1">{open.reasons.map((x, i) => <pre key={i} className="overflow-x-auto rounded-lg bg-sunken p-2 font-mono text-[11.5px] text-ink-2">{JSON.stringify(x)}</pre>)}{!open.reasons.length && <p className="text-[12.5px] text-ink-3">Within healthy limits: no rule fired.</p>}</div>
          {open.fallbacks.length > 0 && <p className="mt-3 text-[12.5px] text-warn">Fallbacks on this row: {open.fallbacks.join(", ")}</p>}
          {(excBySku.get(open.sku_id) ?? []).length > 0 && <><h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-4">Exceptions</h3>{excBySku.get(open.sku_id)!.map((e, i) => <p key={i} className="mt-1 text-[12.5px]"><Badge tone={e.blocking ? "bad" : "warn"}>{e.code}</Badge> {e.detail}</p>)}</>}
          <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-4">Gemini note (advisory only)</h3>
          {open.ai_status === "OK" ? <div className="mt-1 text-[13px] text-ink-2"><p>{open.ai_explanation}</p>{open.ai_unusual && <p className="mt-2"><b>Unusual:</b> {open.ai_unusual}</p>}{open.ai_check && <p className="mt-1"><b>Check:</b> {open.ai_check}</p>}
            <p className="mt-2 text-[12px] text-ink-4">Forecast {open.ai_forecast?.map((x) => Math.round(x)).join(", ")} per week · confidence {open.ai_confidence} · statistical baseline {n1(open.stat_forecast_weekly, 0)}/wk</p></div>
            : <p className="mt-1 text-[13px] text-ink-4">{open.ai_status === "UNAVAILABLE" ? "AI note unavailable" : "Not requested for this row or run."}</p>}
        </div>
      )}
    </div>
  );
}
