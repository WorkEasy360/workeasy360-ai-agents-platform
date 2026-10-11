import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// Integration tests run against the local docker-compose Postgres (or the CI service container).
config({ path: "../../.env", quiet: true });

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: { NODE_ENV: "test", LOG_LEVEL: "warn", ADMIN_REQUIRE_2FA: "false", MOCK_LLM: "true", ALLOW_PRIVATE_EGRESS: "false", AUTH_RATE_LIMIT: "1000", QUEUE_PREFIX: "test", CACHE_TTL_MS: "0" },
    // Test files share one database; run them one at a time.
    fileParallelism: false,
  },
});
