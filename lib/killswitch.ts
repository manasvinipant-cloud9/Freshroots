// Global kill switch. State is the latest row of kill_switch_events, so it persists across restarts and deploys.
import type { Db } from "./db";
import { audit, now } from "./store";

export class KillSwitchEngaged extends Error {}

export type KillState = { engaged: boolean; since: string | null; by: string | null; reason: string | null };

export async function killState(db: Db): Promise<KillState> {
  const r = (await db.query("SELECT * FROM kill_switch_events ORDER BY id DESC LIMIT 1"))[0];
  return { engaged: Boolean(r?.engaged), since: r?.ts ?? null, by: r?.actor ?? null, reason: r?.reason ?? null };
}
export const isEngaged = async (db: Db) => (await killState(db)).engaged;

export async function setKillSwitch(db: Db, engaged: boolean, actor: string, reason = "") {
  await db.query("INSERT INTO kill_switch_events(ts,actor,engaged,reason) VALUES($1,$2,$3,$4)", [now(), actor, engaged, reason]);
  await audit(db, actor, engaged ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF", "kill_switch", "global", null, { reason });
}

export async function requireOff(db: Db, what: string) {
  if (await isEngaged(db)) throw new KillSwitchEngaged(`Kill switch is engaged: ${what} blocked`);
}
