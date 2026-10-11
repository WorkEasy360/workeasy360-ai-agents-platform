# WorkEasy360 Agents

A multi-tenant platform for creating, testing and deploying AI agents. It is a standalone product in the WorkEasy360 ecosystem.

Architecture and launch plan: [docs/architecture/agent-platform-blueprint.md](docs/architecture/agent-platform-blueprint.md). §0 of that document is the current 6-week plan.

## What's in v1.0

| Area | Features |
|---|---|
| Accounts | Email/password and Google sign-in, email verification, organizations, invites, roles (owner/admin/member), two-factor authentication, audit log, data export, organization deletion |
| Agents | "Describe your agent" AI setup, 6 templates, form-based builder with autosave, draft → publish of immutable versions, make an old version live, duplicate, on/off |
| Models | OpenAI, Anthropic, Google behind one model layer; platform credits **or** the org's own key (BYOK), per provider |
| Agent engine | Tool-calling loop with step, time and token limits, conversation memory, cost tracking, defenses against instructions hidden in data |
| Knowledge | Upload PDF/DOCX/TXT/MD/CSV, paste text, import a web page; background processing; hybrid search (pgvector + full text); citations |
| Tools | Custom API tool (URL params, auth from encrypted credentials, SSRF-safe), Send email (fixed recipients only), knowledge search, optional human-approval flag |
| Playground | Streaming test chat with step-by-step trace (model calls, searches, tool calls, tokens, cost) |
| Deploy | Hosted chat page (share link), website widget (one script tag, allowed-sites list), REST API with API keys (sync, streaming, or async with HMAC-signed callbacks) |
| Monitor | Run logs with full traces, conversations with feedback, per-agent analytics, usage page |
| Plans | Free / Starter / Professional / Business / Enterprise limits enforced (agents, messages, AI credits, storage, members, model tiers, channels, branding, log retention) |
| Super admin | `/admin`: overview, organizations (plan, overrides, suspend), users (ban, sessions, roles), agents (disable), executions, usage & cost, plans, models, feature flags, system health, audit log |

## Stack

| Part | Tech |
|---|---|
| Web (`apps/web`) | Next.js 16, React 19, Tailwind CSS 4, TanStack Query |
| API and worker (`apps/api`) | Node.js 22, Express 5, Better Auth, AI SDK 7, BullMQ, Zod |
| Database (`packages/db`) | PostgreSQL 16 + pgvector, Drizzle ORM, row-level security |
| Local services | Docker Compose: Postgres 18 + pgvector, Redis, S3Mock |

## Local setup

Prerequisites: Node 22+, pnpm 10+, Docker Desktop.

```bash
pnpm install
cp .env.example .env            # set BETTER_AUTH_SECRET and LOCAL_MASTER_KEY (commands are in the file)
pnpm services:up                # Postgres :5433, Redis :6379, S3Mock :9090
pnpm db:migrate
pnpm db:seed                    # plans, model catalog, feature flags
pnpm admin:create --email you@company.com --name "You" --password 'a-long-password'
pnpm dev                        # web :3000, API :4000, background worker
```

- Open http://localhost:3000 to sign up. Emails are printed by the worker (`MAIL_TRANSPORT=log`) instead of being sent; links in them work locally.
- **No AI keys needed locally:** with `MOCK_LLM=true` a built-in mock model and mock embeddings stand in for the providers, so every flow works offline. To use real models, set `MOCK_LLM=false` and add `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` (knowledge search uses OpenAI embeddings).
- Postgres uses port **5433** so it doesn't clash with a locally installed Postgres.
- Super admins need 2FA in production (Settings → Security). It's optional locally unless `ADMIN_REQUIRE_2FA=true`.
- To try the widget, add a widget channel on an agent's Deploy tab, add your test site's origin (e.g. `http://localhost:5500`) to Allowed websites, and paste the snippet into a page served from that origin.

## How requests flow

- The browser only talks to the web origin. Next.js proxies `/api/*` to Express locally; in AWS the ALB routes `/api/*` to the API service.
- `/api/v1/*`: signed-in app (session cookie + `X-Org-Id`).
- `/api/v1/runs/agents/:id`: developer API (`Authorization: Bearer we360_sk_...`).
- `/api/public/v1/*`: hosted page and widget (rate-limited, no debug data).
- `/api/admin/v1/*`: super admin, using a separate database role.
- The widget runs in an iframe served from our origin. Which sites may embed it is enforced by CSP `frame-ancestors` (set in `apps/web/src/proxy.ts`). Every other page sends `frame-ancestors 'none'`.

## Tenant isolation

Every tenant table has `org_id` and a Postgres RLS policy.

All tables live in schema `agents` (also locally and in CI), set up by [deploy/sql/01-create-roles-and-schema.sql](deploy/sql/01-create-roles-and-schema.sql). In production that schema sits in a database shared with other WorkEasy360 products.

| Role | Used by | RLS |
|---|---|---|
| `agents_app` | API tenant requests and worker (`appDb()`, `withTenant()`) | **enforced** |
| `agents_owner` | owns schema `agents`: migrations, super admin API, worker jobs (`adminDb()`) | doesn't apply to the owner |

- Tenant queries run inside `withTenant(orgId, tx => ...)`, which sets `app.org_id` for that transaction.
- API keys and public deployment keys are resolved before the tenant is known, through two narrow `SECURITY DEFINER` functions (migration `0001`).
- `apps/api/test/tenant-isolation.test.ts` must stay green.
- Migrations must not name a schema (`pnpm db:generate` strips drizzle's `"public".`; [deploy/scripts/check-migrations.sh](deploy/scripts/check-migrations.sh) fails CI otherwise).

## Tests and builds

```bash
pnpm typecheck
pnpm test                      # API integration + unit tests (needs `pnpm services:up`)
pnpm build
```

Docker images are built only on GitHub Actions (building from the OneDrive folder fails with "unknown file mode").

One-off tasks with the API image: `node dist/scripts/migrate.js` (migrations), `node dist/scripts/seed.js` (catalog, insert-only), `node dist/scripts/create-admin.js` (first super admin).

## Deploying

Production is one EC2 instance in eu-north-1 plus the shared Aurora PostgreSQL cluster (schema `agents` only). Pushing to `main` deploys after CI passes: images are built on GitHub, pushed to GHCR and rolled out over SSH. Setup, operations and the rules for the shared database: [deploy/README.md](deploy/README.md).

The earlier ECS/Fargate Terraform in [infra/terraform](infra/terraform) is not used by this setup.

## Changing the auth schema

Better Auth tables live in `packages/db/src/schema/auth.ts`. After changing auth plugins or fields in `apps/api/src/auth/auth.ts`, regenerate:

```bash
cd apps/api && npx auth@latest generate --config src/auth/auth.ts --output ../../packages/db/src/schema/auth.ts
```

Then re-apply the timestamptz edit noted at the top of the file, and run `pnpm db:generate`.
