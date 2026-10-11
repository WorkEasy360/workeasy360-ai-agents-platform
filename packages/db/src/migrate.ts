import { config } from "dotenv";
import pg from "pg";
import { runMigrations } from "./migrator";

config({ path: "../../.env" });

// Migrations run as the schema owner (DATABASE_URL_ADMIN), never as the RLS-restricted app role.
const url = process.env.DATABASE_URL_ADMIN;
if (!url) throw new Error("DATABASE_URL_ADMIN (the schema owner) is required to run migrations");
const schema = process.env.DB_SCHEMA ?? "agents";

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  console.log(`Applied ${await runMigrations(pool, "./migrations", schema)} migration(s) in schema ${schema}`);
} finally {
  await pool.end();
}
