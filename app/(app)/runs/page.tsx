import Link from "next/link";
import { UploadForm } from "@/components/Actions";
import { Badge, Card } from "@/components/ui";
import { ready } from "@/lib/store";
import { aiCalls, auditLog, dqIssues, runs, uploadedFiles } from "@/lib/queries";
import { when } from "@/lib/format";

export const dynamic = "force-dynamic";
const SEV: Record<string, "bad" | "warn" | "info" | "neutral"> = { HARD_STOP: "bad", SOFT_FIX: "warn", FALLBACK: "info", INFO: "neutral" };

export default async function Page({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const db = await ready();
  const sp = await searchParams;
  const all = await runs(db, 50);
  const sel = all.find((r) => r.run_id === Number(sp.run)) ?? all[0];
  const [dq, ai, audit, files] = await Promise.all([sel ? dqIssues(db, sel.run_id) : [], sel ? aiCalls(db, sel.run_id) : [], auditLog(db, 100), uploadedFiles(db)]);
  return (
    <div className="space-y-5">
      <div><h1 className="text-[20px] font-semibold">Data quality and runs</h1><p className="mt-1 text-[13px] text-ink-3">Every run is recorded, including failed and skipped ones. A hard stop produces a visible FAILED run and no recommendations.</p></div>
      <Card title="Run history">
        <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-[12.5px]"><thead className="text-[11.5px] uppercase text-ink-4"><tr><th className="py-1">Run</th><th>Started</th><th>Status</th><th>Trigger</th><th>As-of</th><th>Week</th><th className="text-right">Secs</th><th className="text-right">SKUs</th><th className="text-right">Exceptions</th><th>Message</th></tr></thead>
          <tbody>{all.map((r) => (
            <tr key={r.run_id} className={`border-t border-line-soft ${sel?.run_id === r.run_id ? "bg-raised/60" : ""}`}>
              <td className="py-1.5"><Link className="text-accent underline underline-offset-2" href={`/runs?run=${r.run_id}`}>#{r.run_id}</Link></td><td>{when(r.started_at)}</td>
              <td><Badge tone={r.status === "SUCCESS" ? "good" : r.status === "FAILED" ? "bad" : "warn"}>{r.status}</Badge></td><td>{r.trigger} · {r.actor}</td><td>{r.as_of ?? "-"}</td><td>{r.last_week ?? "-"}</td>
              <td className="tnum text-right">{r.duration_seconds ?? "-"}</td><td className="tnum text-right">{r.n_recs}</td><td className="tnum text-right">{r.n_exceptions}</td><td className="max-w-[260px] truncate text-ink-3" title={r.message ?? ""}>{r.message}</td></tr>))}
            {!all.length && <tr><td colSpan={10} className="py-6 text-center text-ink-3">No runs yet.</td></tr>}</tbody></table></div>
      </Card>
      {sel && (
        <Card title={`Run #${sel.run_id} detail`} right={<Badge tone={sel.status === "SUCCESS" ? "good" : sel.status === "FAILED" ? "bad" : "warn"}>{sel.status}</Badge>}>
          <p className="text-[13px] text-ink-2">{sel.message}</p>
          <p className="mt-1 text-[12.5px] text-ink-3">Source: {sel.data_source ?? "n/a"} · sales data age {sel.sales_age_days ?? "n/a"} days · inventory age {sel.inventory_age_days ?? "n/a"} days{sel.use_ai ? " · Gemini requested" : " · rules only"}</p>
          {!!sel.fallbacks?.length && <p className="mt-2 text-[12.5px]"><b>Fallbacks used:</b> {sel.fallbacks.join(", ")}</p>}
          <h3 className="mb-1 mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-4">Data-quality report</h3>
          <table className="w-full text-left text-[12.5px]"><tbody>{dq.map((d: any, i: number) => <tr key={i} className="border-t border-line-soft align-top"><td className="w-28 py-1.5"><Badge tone={SEV[d.severity]}>{d.severity.replace("_", " ")}</Badge></td><td className="w-64 font-mono text-[12px]">{d.code}{d.sku_id ? ` (${d.sku_id})` : ""}</td><td className="tnum w-14 text-right">{d.count || ""}</td><td className="pl-3 text-ink-2">{d.detail}</td></tr>)}{!dq.length && <tr><td className="text-ink-3">No issues recorded.</td></tr>}</tbody></table>
          {ai.length > 0 && <><h3 className="mb-1 mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-4">Gemini calls</h3><table className="w-full text-left text-[12.5px]"><tbody>{ai.map((c: any, i: number) => <tr key={i} className="border-t border-line-soft"><td className="py-1.5">batch {c.batch}, attempt {c.attempt}</td><td className="font-mono text-[12px]">{c.model}</td><td><Badge tone={c.status === "OK" ? "good" : "warn"}>{c.status}</Badge></td><td className="text-ink-3">{c.error}</td></tr>)}</tbody></table></>}
        </Card>
      )}
      <Card title="Data source">
        <p className="mb-3 text-[13px] text-ink-2">{files.length ? `Using ${files.length} uploaded exports (latest ${when(files[0].uploaded_at)} by ${files[0].actor}).` : "Using the bundled seed data (as-of 2026-10-19). Upload SAP exports below to replace it."}</p>
        <UploadForm uploaded={files.length > 0} />
      </Card>
      <Card title="Audit log (latest 100)">
        <div className="max-h-[420px] overflow-auto"><table className="w-full text-left text-[12px]"><thead className="sticky top-0 bg-panel text-[11.5px] uppercase text-ink-4"><tr><th className="py-1">When</th><th>Who</th><th>Event</th><th>Entity</th><th>Details</th></tr></thead>
          <tbody>{audit.map((a: any, i: number) => <tr key={i} className="border-t border-line-soft align-top"><td className="whitespace-nowrap py-1">{when(a.ts)}</td><td>{a.actor}</td><td className="font-mono">{a.event_type}</td><td>{a.entity_type} {a.entity_id}</td><td className="max-w-[420px] truncate font-mono text-ink-3" title={JSON.stringify(a.details)}>{JSON.stringify(a.details)}</td></tr>)}</tbody></table></div>
      </Card>
    </div>
  );
}
