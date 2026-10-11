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
 * 5 s to get a connection, a per-statement limit, and no transaction left idle while holding locks.
 */
function createDb(url: string, max: number, statementTimeoutMs: number): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: 60_000,
  });
  return { db: drizzle(pool, { schema }), pool };
}

let appConn: { db: Database; pool: pg.Pool } | undefined;
let adminConn: { db: Database; pool: pg.Pool } | undefined;

/**
 * Connection as `we360_app`. Row-level security applies, so tenant tables return
 * nothing unless the query runs inside `withTenant`.
 * Auth tables (user, session, organization, ...) have no RLS and are safe to use directly.
 */
export function appDb(): Database {
  appConn ??= createDb(requireEnv("DATABASE_URL"), Number(process.env.DB_POOL_MAX ?? 10), Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30_000));
  return appConn.db;
}

/**
 * Connection as `we360_admin` (BYPASSRLS). Only for the worker and the super admin API.
 * Never use it to serve a tenant request.
 */
export function adminDb(): Database {
  // Longer limit: the worker's batched retention deletes and admin reports scan more rows.
  adminConn ??= createDb(requireEnv("DATABASE_URL_ADMIN"), Number(process.env.DB_ADMIN_POOL_MAX ?? 5), Number(process.env.DB_ADMIN_STATEMENT_TIMEOUT_MS ?? 120_000));
  return adminConn.db;
}

/** Runs `fn` in a transaction scoped to one organization. RLS policies read `app.org_id`. */
export async function withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return appDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export async function closeDb(): Promise<void> {
  await Promise.all([appConn?.pool.end(), adminConn?.pool.end()]);
  appConn = undefined;
  adminConn = undefined;
}
