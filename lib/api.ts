import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "./db";
import { defaultActor } from "./pipeline";

/** Wraps a route handler: schema ready, JSON errors, never leaks stack traces. */
export function route<T>(fn: (db: ReturnType<typeof getDb>, req: Request) => Promise<T>) {
  return async (req: Request) => {
    try {
      await ensureSchema();
      return NextResponse.json(await fn(getDb(), req));
    } catch (e) {
      const err = e as Error;
      const status = err.name === "DecisionError" ? 400 : err.name === "KillSwitchEngaged" ? 423 : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
  };
}
export const actorOf = (b: { actor?: string }) => (b.actor ?? "").trim().slice(0, 60) || defaultActor();
