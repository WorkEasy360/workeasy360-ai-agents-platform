/**
 * Prints the number of tables per schema in the shared database, one "schema count" line each:
 * `node dist/scripts/table-counts.js`. deploy.sh runs it before and after migrations and fails if any
 * schema other than the app's own changed. Reads only the catalog (pg_class), which every role can read.
 */
import pg from "pg";

const url = process.env.DATABASE_URL_ADMIN;
if (!url) throw new Error("DATABASE_URL_ADMIN is required");

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
await client.connect();
try {
  const { rows } = await client.query<{ schema: string; tables: number }>(`
    select n.nspname as schema, count(*)::int as tables
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%'
    group by n.nspname order by n.nspname`);
  for (const r of rows) console.log(`${r.schema} ${r.tables}`);
} finally {
  await client.end();
}
