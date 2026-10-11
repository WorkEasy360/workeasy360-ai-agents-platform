/** Local CLI: `pnpm db:seed`. Seeds plans, models and feature flags (see seed-data.ts). */
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { seedCatalog } from "./seed-data";

config({ path: "../../.env" });

const url = process.env.DATABASE_URL_OWNER;
if (!url) throw new Error("DATABASE_URL_OWNER is required to seed");

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  console.log(await seedCatalog(drizzle(pool)));
} finally {
  await pool.end();
}
