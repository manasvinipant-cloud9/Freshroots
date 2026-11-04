import RecsTable from "@/components/RecsTable";
import { Stat } from "@/components/ui";
import { ready } from "@/lib/store";
import { DEFAULT_RULES } from "@/lib/config";
import { latestSuccess, runExceptions, runRecs, runs } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const db = await ready();
  const sp = await searchParams;
  const run = sp.run ? (await runs(db, 200)).find((r) => r.run_id === Number(sp.run) && r.status === "SUCCESS") : await latestSuccess(db);
  if (!run) {
    const failed = (await runs(db, 1))[0];
    return (
      <div className="mx-auto mt-16 max-w-lg text-center">
        <h1 className="text-xl font-semibold">No recommendations yet</h1>
        <p className="mt-2 text-ink-3">{failed ? `The last run ended ${failed.status}: ${failed.message}. See Data quality and runs.` : "Use Run now in the header to run the pipeline on the bundled seed data."}</p>
      </div>
    );
  }
  const [rows, excs] = await Promise.all([runRecs(db, run.run_id), runExceptions(db, run.run_id)]);
  const live = rows.filter((r) => r.status !== "SUPERSEDED");
  const p1 = live.filter((r) => r.priority === "P1").length;
  return (
    <div>
      <h1 className="text-[20px] font-semibold">Recommended actions</h1>
      <p className="mb-4 mt-1 text-[13px] text-ink-3">
        Run {run.run_id}, as-of {run.as_of}, last complete week {run.last_week}.{" "}
        {run.festival_active ? `Festival month: demand is uplifted ${DEFAULT_RULES.festival_uplift_pct}% when measuring weeks of cover.` : "Not a festival month."} Source: {run.data_source}.
      </p>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="P1 stockout-risk rows" value={p1} />
        <Stat label="Pending your decision" value={live.filter((r) => r.status === "PENDING" && !["NO_ACTION", "EXCEPTION"].includes(r.action)).length} />
        <Stat label="Approved / PO drafted" value={live.filter((r) => ["APPROVED", "PO_DRAFTED"].includes(r.status)).length} />
        <Stat label="Exceptions to review" value={new Set(excs.map((e) => e.sku_id)).size} />
      </div>
      <RecsTable rows={rows} excs={excs} mode="main" valueUnit={rows[0]?.value_unit ?? "units"} />
    </div>
  );
}
