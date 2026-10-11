// Manual measurement (not part of the suite): database round trips per request, from the local Postgres
// statement log. Each one is a network round trip in production. Usage:
//   docker compose exec postgres psql -U postgres -c "alter system set log_statement='all'" -c "select pg_reload_conf()"
//   cd apps/api && NODE_ENV=test MOCK_LLM=true QUEUE_PREFIX=test AUTH_RATE_LIMIT=1000 SHOW=1 npx tsx --env-file=../../.env test/roundtrips.manual.ts
//   docker compose exec postgres psql -U postgres -c "alter system reset log_statement" -c "select pg_reload_conf()"
// Last measured: GET /agents 7, GET /agents/:id 7, GET /usage 12, chat message 23 (was 16, 16, 22, 46).
import { execSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { adminDb, closeDb } from "@we360/db";
import { closeQueues } from "../src/lib/queue";
import { ORIGIN, signUpWithOrg } from "./helpers";

const mark = async (m: string) => { await adminDb().execute(sql.raw(`select 'MARK ${m}'`)); };
const who = await signUpWithOrg("rt");
const h = (r: any) => r.set("Origin", ORIGIN).set("x-org-id", who.orgId);
const agent = (await h(who.agent.post("/api/v1/agents")).send({ name: "RT", draft: { instructions: "Be brief." } })).body;
await h(who.agent.post(`/api/v1/agents/${agent.id}/publish`)).send({});
const steps: Array<[string, () => Promise<unknown>]> = [
  ["GET /api/v1/me", () => who.agent.get("/api/v1/me")],
  ["GET /api/v1/agents", () => h(who.agent.get("/api/v1/agents"))],
  ["GET /api/v1/agents/:id", () => h(who.agent.get(`/api/v1/agents/${agent.id}`))],
  ["GET /api/v1/usage", () => h(who.agent.get("/api/v1/usage"))],
  ["POST /agents/:id/test (chat)", () => h(who.agent.post(`/api/v1/agents/${agent.id}/test`)).send({ message: "hello" })],
];
for (const [name, fn] of steps) { await mark(`start ${name}`); await fn(); await mark(`end ${name}`); }
await new Promise((r) => setTimeout(r, 1500));
const log = execSync("docker compose logs --no-log-prefix --since 2m postgres", { cwd: "../..", encoding: "utf8", maxBuffer: 1e8 });
for (const [name] of steps) {
  const s = log.lastIndexOf(`MARK start ${name}`), e = log.lastIndexOf(`MARK end ${name}`);
  const chunk = log.slice(s, e).split("\n").filter((l) => /LOG:\s+(statement|execute)/.test(l) && !l.includes("MARK"));
  console.log(`${String(chunk.length).padStart(3)}  ${name}`);
  if (process.env.SHOW) for (const l of chunk) console.log("      " + l.replace(/^.*?(statement|execute[^:]*):\s*/, "").slice(0, 150));
}
await closeQueues(); await closeDb();
