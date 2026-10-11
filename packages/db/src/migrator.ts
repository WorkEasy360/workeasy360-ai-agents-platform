import { readMigrationFiles } from "drizzle-orm/migrator";
import type pg from "pg";

/**
 * Applies pending migrations from `folder`, all in one transaction, as the connected role (the schema owner).
 *
 * Same history table and rules as drizzle's own migrator (`<schema>.__drizzle_migrations`, a migration is
 * pending when its timestamp is newer than the last applied one), with two differences for the shared
 * production database:
 *  - it never runs `CREATE SCHEMA IF NOT EXISTS`, which needs CREATE on the whole database even when the
 *    schema exists; the schema is created once by deploy/sql/01-create-roles-and-schema.sql;
 *  - it refuses to run unless unqualified names resolve to `schema`, and takes an advisory lock so two
 *    release steps can't migrate at the same time.
 */
export async function runMigrations(pool: pg.Pool, folder: string, schema: string): Promise<number> {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const table = `${quoteIdent(schema)}.${quoteIdent("__drizzle_migrations")}`;
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ schema: string | null }>("select current_schema() as schema");
    if (rows[0]?.schema !== schema) throw new Error(`The connection resolves to schema "${rows[0]?.schema}", expected "${schema}" (check the role's search_path)`);

    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`migrate:${schema}`]);
    await client.query(`create table if not exists ${table} (id serial primary key, hash text not null, created_at bigint)`);
    const last = (await client.query<{ created_at: string }>(`select created_at from ${table} order by created_at desc limit 1`)).rows[0];
    let applied = 0;
    for (const m of migrations) {
      if (last && Number(last.created_at) >= m.folderMillis) continue;
      for (const statement of m.sql) if (statement.trim()) await client.query(statement);
      await client.query(`insert into ${table} (hash, created_at) values ($1, $2)`, [m.hash, m.folderMillis]);
      applied++;
    }
    await client.query("commit");
    return applied;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
