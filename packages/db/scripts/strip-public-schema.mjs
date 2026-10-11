// drizzle-kit qualifies foreign keys with "public". In production the tables live in the app's own schema
// (the roles' search_path), so migrations must not name a schema: strip it after every `generate`.
// deploy/scripts/check-migrations.sh fails CI if a schema name slips through.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql"))) {
  const path = `migrations/${f}`;
  const before = readFileSync(path, "utf8");
  const after = before.replaceAll('"public".', "");
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`stripped "public". from ${path}`);
  }
}
