import { route, actorOf } from "@/lib/api";
import { SCHEMA_MAP } from "@/lib/config";
import { loadFromTexts } from "@/lib/ingest";
import { audit, now } from "@/lib/store";

export const dynamic = "force-dynamic";
const MAX_BYTES = 4_000_000;   // Vercel function body limit is about 4.5 MB; larger exports need the live SAP connector

/** Upload the five SAP export CSVs as one set. Validated against the schema map before anything is stored. */
export const POST = route(async (db, req) => {
  const form = await req.formData();
  const actor = actorOf({ actor: String(form.get("actor") ?? "") });
  if (form.get("reset")) {
    await db.query("DELETE FROM data_files");
    await audit(db, actor, "UPLOAD_RESET", "data_files", "all");
    return { reset: true };
  }
  const texts: Record<string, string> = {};
  for (const spec of Object.values(SCHEMA_MAP.files)) {
    const f = form.get(spec.file);
    if (!(f instanceof File)) throw new Error(`Missing file: ${spec.file} (upload all five exports together)`);
    if (f.size > MAX_BYTES) throw new Error(`${spec.file} is ${(f.size / 1e6).toFixed(1)} MB; the upload limit is ${MAX_BYTES / 1e6} MB`);
    texts[spec.file] = await f.text();
  }
  loadFromTexts(texts, SCHEMA_MAP);               // throws SchemaError naming the missing column
  const ts = now();
  await db.batch([
    ...Object.entries(texts).map(([name, content]) => ({ text: "INSERT INTO data_files(name,content,uploaded_at,actor) VALUES($1,$2,$3,$4) ON CONFLICT (name) DO UPDATE SET content=$2, uploaded_at=$3, actor=$4", params: [name, content, ts, actor] })),
    { text: "INSERT INTO audit_log(ts,actor,event_type,entity_type,entity_id,details) VALUES($1,$2,'DATA_UPLOADED','data_files','all',$3::jsonb)", params: [ts, actor, JSON.stringify({ files: Object.keys(texts) })] },
  ]);
  return { uploaded: Object.keys(texts) };
});
