import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "../../.env" });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // Migrations run as the schema owner, never as the RLS-restricted app role.
  dbCredentials: { url: process.env.DATABASE_URL_ADMIN! },
  entities: { roles: false },
  strict: true,
});
