/**
 * Prepares an existing PostgreSQL server (RDS or Aurora) for the app: `node dist/scripts/db-init.js`.
 * Runs before migrations on every deploy and is safe to re-run.
 *
 * - Creates the database named in DATABASE_URL_OWNER if it doesn't exist.
 * - Creates `we360_app` (row-level security enforced) and `we360_admin` (bypasses it) with the passwords in
 *   DATABASE_URL and DATABASE_URL_ADMIN, and resets those passwords to match on every run.
 * - Grants both roles access to tables the owner creates later (the migrations).
 *
 * Uses the owner (master) connection. It never grants a superuser role to the app roles.
 */
import pg from "pg";

function required(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return new URL(value);
}

const owner = required("DATABASE_URL_OWNER");
const app = required("DATABASE_URL");
const admin = required("DATABASE_URL_ADMIN");
const database = decodeURIComponent(owner.pathname.slice(1));
if (!database) throw new Error("DATABASE_URL_OWNER must name a database");

const roles = [
  { url: app, bypassRls: false },
  { url: admin, bypassRls: true },
];
for (const { url } of roles) {
  if (decodeURIComponent(url.pathname.slice(1)) !== database) throw new Error("All three database URLs must point at the same database");
  if (!url.password) throw new Error(`The URL for ${decodeURIComponent(url.username)} has no password`);
}

/** Connection string for another database on the same server. */
function onDatabase(url: URL, db: string): string {
  const copy = new URL(url);
  copy.pathname = `/${encodeURIComponent(db)}`;
  return copy.toString();
}

async function withClient<T>(connectionString: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

// 1. Database. CREATE DATABASE can't run inside a transaction or take parameters, hence the quoting helpers.
await withClient(onDatabase(owner, "postgres"), async (c) => {
  const { rowCount } = await c.query("select 1 from pg_database where datname = $1", [database]);
  if (!rowCount) {
    await c.query(`create database ${ident(database)}`);
    console.log(`Created database ${database}`);
  }
});

// 2. Roles and default privileges.
await withClient(owner.toString(), async (c) => {
  const ownerRole = (await c.query<{ u: string }>("select current_user as u")).rows[0]!.u;
  for (const { url, bypassRls } of roles) {
    const name = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const exists = (await c.query("select 1 from pg_roles where rolname = $1", [name])).rowCount;
    const attrs = `login ${bypassRls ? "bypassrls" : "nobypassrls"} password ${literal(password)}`;
    await c.query(exists ? `alter role ${ident(name)} ${attrs}` : `create role ${ident(name)} ${attrs}`);
    if (!exists) console.log(`Created role ${name}`);
    await c.query(`grant connect on database ${ident(database)} to ${ident(name)}`);
    await c.query(`grant usage on schema public to ${ident(name)}`);
    await c.query(`alter default privileges for role ${ident(ownerRole)} in schema public grant select, insert, update, delete on tables to ${ident(name)}`);
    await c.query(`alter default privileges for role ${ident(ownerRole)} in schema public grant usage, select on sequences to ${ident(name)}`);
  }
  // The app role must never bypass row-level security, whatever happened to it before.
  const check = await c.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
    "select rolname, rolbypassrls, rolsuper from pg_roles where rolname = any($1)",
    [roles.map((r) => decodeURIComponent(r.url.username))],
  );
  for (const r of check.rows) {
    const expected = roles.find((x) => decodeURIComponent(x.url.username) === r.rolname)!.bypassRls;
    if (r.rolsuper || r.rolbypassrls !== expected) throw new Error(`Role ${r.rolname} has unexpected privileges (superuser=${r.rolsuper}, bypassrls=${r.rolbypassrls})`);
  }
});

console.log("Database ready");
