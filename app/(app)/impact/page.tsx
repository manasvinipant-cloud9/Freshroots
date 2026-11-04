import { Card, Stat } from "@/components/ui";
import { ready } from "@/lib/store";
import { APP } from "@/lib/config";
import { REASON_LABEL } from "@/lib/format";
import { decisionStats, latestSuccess, runRecs } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Page() {
  const db = await ready();
  const [run, stats] = await Promise.all([latestSuccess(db), decisionStats(db)]);
  const p1 = run ? (await runRecs(db, run.run_id)).filter((r) => r.priority === "P1").length : null;
  const c = (d: string) => stats.filter((s) => s.decision === d).reduce((a, s) => a + s.n, 0);
  const ap = c("APPROVE"), rj = c("REJECT"), ed = c("EDIT"), decided = ap + rj;
  const reasons = stats.filter((s) => s.reason_code).reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason_code!]: (m[s.reason_code!] ?? 0) + s.n }), {});
  const bc = APP.baseline_case;
  return (
    <div className="space-y-5">
      <div><h1 className="text-[20px] font-semibold">Impact: what the system can measure</h1><p className="mt-1 text-[13px] text-ink-3">The case&apos;s baseline next to numbers measured from real runs and decisions. No savings figure is shown: the data has no prices or outcomes to support one honestly.</p></div>
      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Baseline from the case">
          <div className="grid grid-cols-1 gap-3"><Stat label="Planning errors (stockouts plus overstock)" value={`Rs ${bc.planning_error_cost_lakhs_per_quarter} lakh / quarter`} />
            <Stat label="Forecast cycle" value="Monthly" sub={bc.forecast_cycle} /><Stat label="Manual data preparation" value={`~${bc.manual_prep_days_per_month} days / month`} /></div>
        </Card>
        <Card title="Measured by this system">
          <div className="grid grid-cols-1 gap-3">
            <Stat label="Cycle time, latest run" value={run?.duration_seconds != null ? `${run.duration_seconds}s` : "n/a"} sub={`Runs ${APP.schedule.label}, versus monthly`} />
            <Stat label="Forecast data age at run" value={run ? `${run.sales_age_days ?? "n/a"} days (sales), ${run.inventory_age_days ?? "n/a"} days (inventory)` : "n/a"} sub="Measured against the run's as-of date" />
            <Stat label="P1 stockout-risk flags, latest run" value={p1 ?? "n/a"} />
          </div>
        </Card>
      </div>
      <Card title="Human decisions">
        {decided + ed === 0 ? <p className="text-[13px] text-ink-3">No decisions recorded yet.</p> : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Approval rate" value={decided ? `${Math.round((100 * ap) / decided)}%` : "n/a"} sub={`${ap} approved, ${rj} rejected`} />
              <Stat label="Override rate" value={`${Math.round((100 * (rj + ed)) / Math.max(decided, 1))}%`} sub={`${rj} rejections + ${ed} quantity edits`} />
              <Stat label="Decisions logged" value={ap + rj + ed} />
            </div>
            <h3 className="mb-2 mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-4">Override reasons (training data for the next phase)</h3>
            <div className="space-y-1.5">{Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <div key={k} className="flex items-center gap-3 text-[12.5px]"><span className="w-36 text-ink-2">{REASON_LABEL[k] ?? k}</span><div className="h-2 rounded bg-accent" style={{ width: `${Math.max(6, (v / Math.max(...Object.values(reasons))) * 240)}px` }} /><span className="tnum text-ink-3">{v}</span></div>))}</div>
          </>)}
      </Card>
    </div>
  );
}
