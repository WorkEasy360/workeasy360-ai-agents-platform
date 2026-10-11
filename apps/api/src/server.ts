import { assertDbSchema, closeDb } from "@we360/db";
import { env } from "./config/env";
import { createApp } from "./app";
import { logger } from "./lib/logger";

// Refuse to start if the database roles don't resolve to the app's own schema (shared database).
await assertDbSchema();

const server = createApp().listen(env.API_PORT, () => {
  logger.info(`API listening on http://localhost:${env.API_PORT}`);
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  // Docker gives 10s after SIGTERM by default (stop_grace_period in docker-compose.prod.yml is 30s).
  setTimeout(() => process.exit(1), 20_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
