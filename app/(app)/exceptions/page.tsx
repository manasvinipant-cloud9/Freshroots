import RecsTable from "@/components/RecsTable";
import { ready } from "@/lib/store";
import { latestSuccess, runExceptions, runRecs } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Page() {
  const db = await ready();
  const run = await latestSuccess(db);
  if (!run) return <p className="mt-10 text-center text-ink-3">No successful run yet.</p>;
  const [rows, excs] = await Promise.all([runRecs(db, run.run_id), runExceptions(db, run.run_id)]);
  return (
    <div>
      <h1 className="text-[20px] font-semibold">Exceptions queue</h1>
      <p className="mb-4 mt-1 text-[13px] text-ink-3">SKUs that need Raghav&apos;s judgment. Blocking exceptions have no rule action; others show both and are marked &quot;review before approving&quot;. Gemini explains what looks unusual and what to check, but never decides.</p>
      <RecsTable rows={rows} excs={excs} mode="exceptions" valueUnit="units" />
    </div>
  );
}
