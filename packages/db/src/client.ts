import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema/index";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * Bounded waits, so a stuck lock or a full pool fails a request instead of hanging it:
 * 10 s to get a connection, a per-statement limit, and no transaction left idle while holding locks.
 */
function createDb(url: string, max: number, statementTimeoutMs: number): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    // The production database is in another region (~150 ms away): allow for the TLS handshake.
    connectionTimeoutMillis: 10_000,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: 60_000,
  });
  return { db: drizzle(pool, { schema }), pool };
}

let appConn: { db: Database; pool: pg.Pool } | undefined;
let adminConn: { db: Database; pool: pg.Pool } | undefined;

/**
 * Connection as the app role (`agents_app`). Row-level security applies, so tenant tables return
 * nothing unless the query runs inside `withTenant`.
 * Auth tables (user, session, organization, ...) have no RLS and are safe to use directly.
 */
export function appDb(): Database {
  appConn ??= createDb(requireEnv("DATABASE_URL"), Number(process.env.DB_POOL_MAX ?? 10), Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30_000));
  return appConn.db;
}

/**
 * Connection as the schema owner (`agents_owner`), which row-level security doesn't apply to.
 * Only for the worker, migrations and the super admin API.
 * Never use it to serve a tenant request.
 */
export function adminDb(): Database {
  // Longer limit: the worker's batched retention deletes and admin reports scan more rows.
  adminConn ??= createDb(requireEnv("DATABASE_URL_ADMIN"), Number(process.env.DB_ADMIN_POOL_MAX ?? 5), Number(process.env.DB_ADMIN_STATEMENT_TIMEOUT_MS ?? 120_000));
  return adminConn.db;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction scoped to one organization. RLS policies read `app.org_id`.
 *
 * BEGIN and the tenant setting go to the server as one multi-statement query, one round trip instead of
 * two (the production database is in another region). A multi-statement query can't take parameters,
 * so the organization id is inlined, which is safe only because it must be a canonical UUID.
 * `fn` gets a drizzle instance bound to the transaction's connection: use its query builders only
 * (no nested `.transaction()`, no relational `.query` API).
 */
export async function withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(orgId)) throw new Error("withTenant: the organization id must be a UUID");
  appDb();
  const client = await appConn!.pool.connect();
  let discard = false;
  try {
    await client.query(`begin; select set_config('app.org_id', '${orgId}', true)`);
    const result = await fn(drizzle(client) as unknown as Tx);
    await client.query("commit");
    return result;
  } catch (err) {
    // If even the rollback fails, the connection is in an unknown state: don't return it to the pool.
    await client.query("rollback").catch(() => {
      discard = true;
    });
    throw err;
  } finally {
    client.release(discard);
  }
}

export async function closeDb(): Promise<void> {
  await Promise.all([appConn?.pool.end(), adminConn?.pool.end()]);
  appConn = undefined;
  adminConn = undefined;
}

/**
 * Refuses to run when the connections don't resolve unqualified names to the app's own schema
 * (DB_SCHEMA, default `agents`). In the shared production database a wrong search_path would read or
 * write another product's tables of the same name, so this runs at startup of the API and worker.
 */
export async function assertDbSchema(): Promise<void> {
  const expected = process.env.DB_SCHEMA ?? "agents";
  for (const [name, db] of [["DATABASE_URL", appDb()], ["DATABASE_URL_ADMIN", adminDb()]] as const) {
    const { rows } = await db.execute<{ schema: string | null }>(sql`select current_schema() as schema`);
    if (rows[0]?.schema !== expected) {
      throw new Error(`${name} resolves to schema "${rows[0]?.schema}", expected "${expected}" (check the role's search_path)`);
    }
  }
}
