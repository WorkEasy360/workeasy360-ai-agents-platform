import { assertDbSchema, closeDb } from "@we360/db";
import { env } from "./config/env";
import { createApp } from "./app";
import { logger } from "./lib/logger";
import { Workeasy360ConfigError } from "./workeasy360/config";
import { runtimeFromEnv } from "./workeasy360/runtime";

// Refuse to start if the database roles don't resolve to the app's own schema (shared database).
await assertDbSchema();

// Refuse to start with a half-configured WorkEasy360 sign-in (docs/workeasy360-sso.md#environment).
let workeasy360;
try {
  workeasy360 = runtimeFromEnv() ?? null;
} catch (err) {
  console.error(err instanceof Workeasy360ConfigError ? err.message : err);
  process.exit(1);
}

const server = createApp({ workeasy360 }).listen(env.API_PORT, () => {
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
