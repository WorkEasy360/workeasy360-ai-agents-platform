import { closeDb } from "@we360/db";
import { env } from "./config/env";
import { createApp } from "./app";
import { logger } from "./lib/logger";

const server = createApp().listen(env.API_PORT, () => {
  logger.info(`API listening on http://localhost:${env.API_PORT}`);
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  // ECS gives 30s after SIGTERM; leave headroom.
  setTimeout(() => process.exit(1), 20_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
