/**
 * Applies database migrations. In AWS this runs as a one-off ECS task (same image as the API)
 * before each deploy: `node dist/scripts/migrate.js`. Uses the owner connection, never the app role.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL_OWNER;
if (!url) throw new Error("DATABASE_URL_OWNER is required to run migrations");

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: process.env.MIGRATIONS_DIR ?? "./migrations" });
  console.log("Migrations applied");
} finally {
  await pool.end();
}
