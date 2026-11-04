import { route, actorOf } from "@/lib/api";
import { killState, setKillSwitch } from "@/lib/killswitch";

export const dynamic = "force-dynamic";

export const POST = route(async (db, req) => {
  const b = await req.json();
  await setKillSwitch(db, Boolean(b.engaged), actorOf(b), String(b.reason ?? "").slice(0, 200));
  return killState(db);
});
