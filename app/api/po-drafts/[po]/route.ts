import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Download the exact Zoho payload of a PO draft. */
export async function GET(_req: Request, { params }: { params: Promise<{ po: string }> }) {
  await ensureSchema();
  const { po } = await params;
  const row = (await getDb().query("SELECT payload FROM po_drafts WHERE po_number=$1", [po]))[0];
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(JSON.stringify(row.payload, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${po}.json"` } });
}
