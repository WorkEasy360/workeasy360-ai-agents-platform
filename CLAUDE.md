# WorkEasy360 AI Agents

Read [DEVELOPMENT.md](./DEVELOPMENT.md) first: local setup, code map, rules, feature checklist, deployment and gotchas. Production runbook: [deploy/README.md](./deploy/README.md).

Non-negotiables:
- **Pushing to `main` deploys to production** through GitHub Actions (CI, then Deploy). Only push when the user asks.
- **The production database is a SHARED Aurora cluster.** This app may only touch schema `agents`, as roles `agents_app` (API) and `agents_owner` (worker, migrations).
  - Never run `drizzle-kit push`, resets, drops or seeds other than the insert-only catalog seed against it.
  - Never touch schemas `public`, `helpdesk` or `hrms`.
  - Never connect the app as `postgres`.
  - Migrations must not name a schema (`deploy/scripts/check-migrations.sh`).
- **Tenant data only inside `withTenant(orgId, tx => …)`** (RLS). `adminDb()` is for the worker, migrations and the platform-admin API only.
- **The production DB is ~150 ms away:** no queries in loops, prefer single statements and one `withTenant` per request. Count round trips with `apps/api/test/roundtrips.manual.ts`.
- **Email goes only through `modules/notifications/notify.ts`.** Code must also work with email off (`SES_REGION` unset).
- **Never print or commit secrets.** Production settings live only in `~/agents/deploy/.env` on the server. Don't touch the HRMS server (52.66.103.213).
- **Local services are Docker Compose** (Postgres 18 on 5433, Redis, S3Mock; start Docker Desktop first). Docker images are built only on GitHub (OneDrive breaks local builds).
- **Before finishing a change:** `pnpm typecheck && pnpm test && pnpm build`.
