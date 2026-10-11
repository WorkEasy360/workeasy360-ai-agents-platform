# Developer guide

Everything you need to change WorkEasy360 AI Agents and ship it. Production details live in [deploy/README.md](./deploy/README.md); product and architecture background in [README.md](./README.md) and [docs/architecture](./docs/architecture).

## At a glance

| | |
|---|---|
| **Live site** | _set after the first deploy_ (API under `/api`, health at `/api/health`) |
| **Repository** | https://github.com/WorkEasy360/workeasy360-ai-agents-platform, branch `main` |
| **Deploy** | Push to `main`. CI runs; if it passes, GitHub Actions builds the images and rolls them out to the EC2 host. |
| **Stack** | pnpm + Turborepo. API: Express 5 + TypeScript + Drizzle + Better Auth, BullMQ worker. Web: Next.js 16 + React 19 + Tailwind. |
| **Production DB** | Shared Aurora PostgreSQL 18 (eu-north-1). This app owns schema `agents` only, as roles `agents_app` (API, RLS applies) and `agents_owner` (worker, migrations). |
| **Server** | EC2 `16.171.214.145` (eu-north-1, same region and VPC as the database; Ubuntu 26.04, t3.small), user `ubuntu`, deploy files in `~/agents/deploy` |

## Run it locally

Prerequisites: Node 22, pnpm 10, Docker Desktop.

```bash
pnpm install
cp .env.example .env      # first time: set BETTER_AUTH_SECRET and LOCAL_MASTER_KEY (commands are in the file)
pnpm services:up          # Postgres 18 + pgvector :5433, Redis :6379, S3Mock :9090
pnpm db:migrate
pnpm db:seed              # plans, model catalog, feature flags (insert-only)
pnpm admin:create --email you@company.com --name "You" --password 'a-long-password'
pnpm dev                  # web :3000, API :4000, worker
```

The local database is set up exactly like production. The same [deploy/sql/01-create-roles-and-schema.sql](deploy/sql/01-create-roles-and-schema.sql) runs when the Docker volume is created:
- database `postgres`
- schema `agents`
- roles `agents_app` and `agents_owner`

Useful local switches in `.env`:
- **`MAIL_TRANSPORT=log` (default locally):** the worker prints every email (verification, reset, invitation, notices) instead of sending it. Links in the log open the real pages.
- **`MOCK_LLM=true`:** a built-in mock model and mock embeddings stand in for the AI providers, so everything works offline.
- **`ALLOW_PUBLIC_SIGNUP=false`:** invitation-only sign-up, like production.

## Where things are

**API (`apps/api/src`):**
- `app.ts`: middleware (helmet, request ids, rate limits, CSRF origin check), routes, `/api/health`.
- `server.ts`, `worker.ts`: the two processes. Both refuse to start unless the database roles resolve to schema `agents`.
- `auth/`: Better Auth configuration, sign-up rules, lockout, password hashing.
- `middleware/auth.ts`:
  - `requireSession`
  - `requireTenant` (membership check; default workspace is cached)
  - `requireRole`
- `modules/<feature>/`: one router plus services per feature (agents, knowledge, tools, runs, deployments, usage, privacy, admin…).
- `modules/notifications/notify.ts`: **every email the platform sends.** `lib/mailer.ts` queues them; the worker delivers them through SES.
- `runtime/`: the agent run loop and tools (HTTP tool with SSRF protection, send-email tool).
- `scripts/`: `migrate`, `seed`, `create-admin`, `table-counts` (all built into the image as `dist/scripts/*.js`).

**Database (`packages/db`):**
- `src/schema/`: Drizzle tables. Tenant tables get `tenantPolicy()` (RLS).
- `src/client.ts`:
  - `appDb()` (agents_app)
  - `adminDb()` (agents_owner)
  - `withTenant(orgId, tx => …)`
  - `assertDbSchema()`
- `src/migrator.ts`: applies migrations inside the app's schema only.
- `migrations/`: SQL migrations. `0000_baseline` is the full schema; `0001` holds the two lookup functions.

**Web (`apps/web/src`):** `app/(app)` (signed-in pages), `app/(auth)` (sign-in, sign-up, reset, invitations), `app/admin` (platform admin), `app/c` and `app/embed` (hosted chat and widget), `lib/` (API client, auth client, `usePlatform()`).

**Deploy (`deploy/`):** see [deploy/README.md](deploy/README.md).

## Rules the code follows (keep them)

**Tenant isolation and security**
- **Tenant data is read and written only inside `withTenant(orgId, tx => …)`.** RLS enforces it for `agents_app`. `adminDb()` sees every tenant: use it only in the worker, migrations and the platform-admin API.
- **Inside `withTenant`, use only the query builders** (`tx.select/insert/update/delete/execute`). Don't use a nested `.transaction()` or the relational `.query` API: `tx` is a plain connection-bound instance.
- **Validate input with zod** (`parse(schema, req.body)` from `lib/http.ts`). IDs from a request body that reference other objects must be checked inside the tenant (see `assertReferencesExist` in agents).
- **Token types stay separate:**
  - session cookies authenticate `/api/v1`
  - `we360_sk_` API keys authenticate only `/api/v1/runs`
  - `pk_` keys authenticate only the public chat API
  - `test/security.test.ts` checks this.

**Keep database round trips low** (the server and database share a region, ~1 ms each, but every request pays for each one, and the code was tuned for a database ~150 ms away)
- **Measure.** `apps/api/test/roundtrips.manual.ts` counts statements per request.
- **One statement beats several.** Use subqueries and joins. See `getUsageSummary` and `GET /agents`.
- **One `withTenant` per request where possible.** Each costs 2 round trips (begin+set, commit) on top of its statements.
- **No queries in loops.** Load with `inArray`, insert arrays in one statement.
- **Statements in one transaction run one after another on one connection.** `Promise.all` only helps across separate `withTenant` calls or non-transactional reads.
- **Rarely-changing data is cached per process with `ttlCache`:** plan limits 30 s, model catalog 60 s, default workspace 10 min. Writers clear the cache: `clearOrgLimits()`, `clearModelCache()`.

**Emails and side effects**
- **Send email only through `notify.*`.** It queues the message, never throws, and doesn't slow the request.
- **Code must work with email off** (`SES_REGION` unset → `env.emailEnabled` false):
  - accounts need no verification
  - invitation links are shown in Settings → Members
  - platform admins can create password-reset links
- **Single-use tokens** (password reset) are stored as SHA-256 hashes (Better Auth `verification.storeIdentifier: "hashed"`). Forgot-password answers the same way whether or not the email exists.

**Frontend**
- **Next.js 16 differs from older versions.** Check `apps/web/node_modules/next/dist/docs/` before using a Next API you haven't used here.
- **Security headers and CSP live in** `apps/web/src/lib/security-headers.ts` and `proxy.ts` (widget `frame-ancestors`).

## Adding a feature: checklist

1. **Schema change?**
   - Edit `packages/db/src/schema/*`, then `pnpm db:generate`. This generates the SQL and strips drizzle's `"public".` prefix. Then `pnpm db:migrate` locally.
   - Migrations must not name a schema, create extensions, roles or schemas, or grant/revoke. `bash deploy/scripts/check-migrations.sh` runs in CI and on every deploy.
   - Prefer additive changes: new tables, nullable columns or columns with defaults. Migrations only go forward in production, and a rollback runs the previous code against the new schema.
2. **New tenant table:** add `org_id` and `tenantPolicy()` (RLS), and extend `test/tenant-isolation.test.ts` or `test/cross-tenant-refs.test.ts`.
3. **New email:** add a function to `modules/notifications/notify.ts`, with recipients and text, and handle email being off.
4. **New environment variable:**
   - read it in `apps/api/src/config/env.ts`
   - document it in `.env.example` and `deploy/.env.example`
   - add it to the server's `deploy/.env`
5. **Check before pushing:**
   ```bash
   pnpm typecheck && pnpm test && pnpm build
   ```
6. Push to `main` and watch **Actions → CI**, then **Deploy**.

## Deployment

How it works (details: [deploy/README.md](./deploy/README.md)):
1. **CI** runs on every push to `main`, except pushes that only change Markdown:
   - tests against Postgres 18 with the production role setup
   - typecheck, build and the migration check
   - dependency audit, secret scan and config scan
2. **Deploy** runs when CI passes. You can also start it by hand: Actions → Deploy → Run workflow.
   - It builds `ghcr.io/workeasy360/agents-api` and `agents-web`, tagged with the commit SHA, **on GitHub**.
   - It copies `deploy/` and `packages/db/migrations/` to `~/agents` on the server and runs `deploy/scripts/deploy.sh`:
     1. preflight checks on `.env`
     2. check-migrations
     3. pull
     4. table counts
     5. one-off migrate + catalog seed
     6. table counts again: everything outside `agents` must be unchanged
     7. `up -d`
     8. wait for healthy
3. **Smoke test:** `https://DOMAIN/api/health` and `/login`.

**Rollback:** Actions → Deploy → pick an older successful run → Re-run all jobs.

**Server access:**
```bash
ssh -i <path-to-key>.pem ubuntu@<elastic-ip>
cd ~/agents/deploy
C="docker compose -f docker-compose.prod.yml"
$C ps                        # status and health
$C logs -f --tail=200 api    # or worker, web, nginx
```

**Changing a production setting:** edit `~/agents/deploy/.env` on the server. It's `chmod 600` and exists only there, never in git. Then run `$C up -d api worker`.

### Never do this in production

- **No destructive or schema-wide commands against Aurora:** no `drizzle-kit push`, no resets or drops, no demo seeds (`seed-demo` is local only). Releases only run `dist/scripts/migrate.js` and the insert-only catalog seed.
- **Leave other schemas alone:** don't touch `public`, `helpdesk` or `hrms`, and don't change grants for other roles. The Aurora admin login (`postgres`) is only for the one-time `deploy/sql/01-create-roles-and-schema.sql`.
- **Don't build images on the server or from a PC.** GitHub Actions builds them.
- **Don't commit `.env` files or keys.** Don't touch the HRMS server (52.66.103.213).

## Gotchas

- **Windows + OneDrive:** `docker build` from this folder fails with `unknown file mode`. Let GitHub build.
- **Line endings:** `.gitattributes` forces LF on scripts, SQL, YAML and templates. CRLF breaks bash on the server.
- **Killed dev servers** can leave `node` processes holding ports 3000/4000. Find them with `Get-NetTCPConnection -LocalPort 4000`.
- **Rate limits:** about 10 sign-in and password requests per minute per IP, plus a 15-minute lock after 10 failed passwords on one account. Test scripts hit 429 by design.
- **Caches:**
  - Changing a plan directly in the database takes up to 30 s to apply in a running API. The admin screens clear the cache immediately.
  - Tests disable caching (`CACHE_TTL_MS=0`).
- **Shared cluster capacity:** Aurora allows 79 connections in total. This app's roles are capped at 20 (agents_app 12, agents_owner 8); the pool sizes in `docker-compose.prod.yml` stay below that.
