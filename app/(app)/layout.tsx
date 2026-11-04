import Shell from "@/components/Shell";
import { dbConfigured, ensureSchema, getDb } from "@/lib/db";
import { killState } from "@/lib/killswitch";
import { latestSuccess } from "@/lib/queries";
import { when } from "@/lib/format";
import { APP } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!dbConfigured()) {
    return <div className="mx-auto max-w-xl p-10"><h1 className="text-xl font-semibold">Database not configured</h1><p className="mt-2 text-ink-3">Set <code>DATABASE_URL</code> to a Neon Postgres connection string (see <code>.env.example</code>), then run <code>npm run migrate</code>.</p></div>;
  }
  await ensureSchema();
  const db = getDb();
  const [kill, last] = await Promise.all([killState(db), latestSuccess(db)]);
  return <Shell kill={kill} lastRun={last ? when(last.finished_at ?? last.started_at) : null} schedule={APP.schedule.label}>{children}</Shell>;
}
