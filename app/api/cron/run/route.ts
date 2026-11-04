import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/lib/db";
import { runPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Twice-weekly job (vercel.json, Mon + Thu 07:00 IST = 01:30 UTC). Skips itself when the kill switch is on. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await ensureSchema();
  return NextResponse.json(await runPipeline({ db: getDb(), trigger: "scheduled", actor: "scheduler" }));
}
