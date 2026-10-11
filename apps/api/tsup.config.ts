import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "src/server.ts",
    worker: "src/worker.ts",
    // Loaded by the worker as a thread (new URL("./parse-worker.js", import.meta.url)), so it must sit next to worker.js.
    "parse-worker": "src/modules/knowledge/parse-worker.ts",
    "scripts/create-admin": "src/scripts/create-admin.ts",
    "scripts/db-init": "src/scripts/db-init.ts",
    "scripts/migrate": "src/scripts/migrate.ts",
    "scripts/seed": "src/scripts/seed.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them into the output.
  noExternal: [/^@we360\//],
});
