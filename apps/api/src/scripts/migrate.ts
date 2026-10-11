/**
 * Applies database migrations: `node dist/scripts/migrate.js`. In production this is a one-off release step
 * (deploy/scripts/deploy.sh runs it before starting the new version), never part of app startup.
 * Runs as the schema owner (DATABASE_URL_ADMIN), never as the app role, only inside DB_SCHEMA.
 */
import pg from "pg";
import { runMigrations } from "@we360/db";

const url = process.env.DATABASE_URL_ADMIN;
if (!url) throw new Error("DATABASE_URL_ADMIN (the schema owner) is required to run migrations");
const schema = process.env.DB_SCHEMA ?? "agents";

const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
try {
  console.log(`Applied ${await runMigrations(pool, process.env.MIGRATIONS_DIR ?? "./migrations", schema)} migration(s) in schema ${schema}`);
} finally {
  await pool.end();
}
