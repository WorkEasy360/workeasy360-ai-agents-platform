/**
 * Seeds plans, the model catalog and feature flags in AWS: `node dist/scripts/seed.js`
 * (one-off release step, same image as the API). Safe to re-run; uses the owner connection.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { seedCatalog } from "@we360/db/seed-data";

const url = process.env.DATABASE_URL_ADMIN;
if (!url) throw new Error("DATABASE_URL_ADMIN (the schema owner) is required to seed");

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  console.log(await seedCatalog(drizzle(pool)));
} finally {
  await pool.end();
}
