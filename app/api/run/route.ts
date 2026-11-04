import { route, actorOf } from "@/lib/api";
import { runPipeline } from "@/lib/pipeline";
import { validDate } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = route(async (db, req) => {
  const b = await req.json().catch(() => ({}));
  const asOf = b.asOf ? String(b.asOf) : null;
  if (asOf && !validDate(asOf)) throw new Error("As-of date must be YYYY-MM-DD");
  return runPipeline({ db, asOf, useAi: b.useAi !== false, trigger: "dashboard", actor: actorOf(b) });
});
