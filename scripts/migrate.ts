import { getDb, migrate } from "../lib/db";

migrate(getDb()).then(() => console.log("Schema is up to date.")).catch((e) => { console.error(e); process.exit(1); });
