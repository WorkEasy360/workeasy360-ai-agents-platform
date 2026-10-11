# WorkEasy360 AI Agent Platform: Research, Product Specification & Architecture

> **Status:** v0.2 (2026-10-02). Decisions confirmed by the product owner. **§0 overrides any earlier section it conflicts with.** Sections A–AH are the long-term blueprint; §0 is the launch plan.
> Mermaid diagrams from §AB are also available individually in `docs/architecture/diagrams/`.

---

## Context

WorkEasy360 is a multi-product ecosystem (about six products in progress, each in its own repository). The **AI Agent Platform** is a new WorkEasy360 product: an **independent web application** where technical and non-technical users create, configure, test, deploy and monitor AI agents. Over time it can become the shared AI layer across WorkEasy360, but at launch it stands alone. This document is the blueprint: research, scope, architecture, schema, APIs and roadmap.

Research note: SailoAI (sailoai.com) is an **independent platform, not part of WorkEasy360**. It is used here only as a competitor/reference.

---

## 0. Confirmed Decisions & 6-Week Launch Plan (v0.2)

### 0.1 Decisions

| # | Question | Decision | Effect on the blueprint |
|---|---|---|---|
| 1 | SailoAI | Independent platform; reference only | No SailoAI integration, CRM tool pack or WhatsApp reuse |
| 2 | Identity | Shared WE360 login is planned but not built | **Build auth inside this app** behind an `AuthProvider` interface, ready to move to the shared login later (§0.3) |
| 3 | Repository | Every product has its own repo | **One standalone repo** for this product (pnpm workspace, §0.8). No shared WE360 packages yet |
| 4 | Infrastructure | AWS already set up in **Mumbai (`ap-south-1`)** | Deploy into the existing account and region |
| 5 | Model keys | **Both platform keys and bring-your-own-key (BYOK)** at launch | Design in §0.4 |
| 6 | Team and date | **5 engineers, launch in about 6 weeks** (target week of 2026-11-16) | Scope cut to a launch release (§0.2); the ~20-week Phase 1 becomes the post-launch roadmap |
| 7 | Channel | **Independent web platform** | The web app is the product. Agents are shared through a hosted chat page, a web widget and the REST API. No embedding into other WE360 products at launch |
| 8 | Plans | **Enforce plan limits at launch** | Plans and limits model (§0.5) |
| + | Super admin | **Super admin dashboard at launch** | §0.6 |
| + | Backend framework | **Node.js + Express 5** (no NestJS, no Fastify) | §0.8, §V, §AG updated |
| + | Locked stack | TypeScript, Next.js, PostgreSQL + pgvector, Redis, S3, own model layer, form-based builder, versioned agents, multi-tenant design, encrypted credentials, REST API | Treated as final |

**Honest timeline note:** The full Phase 1 in §G was estimated at about 20 weeks. Six weeks with five engineers covers roughly 40% of it. The plan below keeps the foundations that are expensive to retrofit (tenant isolation, versions, encryption, usage metering, SSRF safety, limits) and cuts features that can be added without rework. **Recommendation: launch as a public beta / early access.** That sets expectations while the v1.1 features arrive.

### 0.2 Launch Scope (v1.0, 6 weeks)

**In v1.0 (must ship)**

| Area | Included |
|---|---|
| Accounts | Sign up / log in with email + password (email verification, password reset) and Google; create organization; invite members; roles **Owner / Admin / Member** |
| Tenancy | Organization → one default workspace (the workspace table exists, but the multi-workspace UI comes in v1.1); `org_id` on every row + Postgres RLS |
| Agents | Create, edit, duplicate, disable, delete; **draft → publish versions**; restore an old version |
| Builder | Tabs: Identity, Instructions, Model, Knowledge, Tools, Settings (welcome message, fallback message, limits), with a live playground beside them |
| Templates | 3 starters: Customer Support FAQ, Lead Qualifier, Internal Helpdesk |
| Models | OpenAI, Anthropic, Google Gemini through our `ModelGateway`; **platform keys + BYOK** |
| Knowledge | Upload PDF, DOCX, TXT, MD, CSV; paste text; background ingestion with status; hybrid search (vector + keyword); citations |
| Tools | Knowledge Search (built in); **Custom HTTP/API tool** with API-key/bearer credential, SSRF protection |
| Playground | Streaming chat; trace panel (steps, tool calls, retrieved chunks, tokens, cost, latency, errors); reset; test draft vs published |
| Deploy | **Hosted chat page** (public link per agent), **web widget** (embed snippet, allowed domains, basic theme), **REST API** with API keys (sync + streaming) |
| Observability | Executions list and detail; conversations stored |
| Usage & plans | Per-call token and cost records; org Usage page; **plan limit enforcement** with clear upgrade messages |
| Super admin | Launch subset in §0.6 |
| Security | Encrypted credentials and BYOK keys (KMS), RLS, rate limits, widget origin checks, execution limits, audit log writing |

**Moved to v1.1 (weeks 7–12, in this order)**
1. Online payments (Razorpay recommended for India) and self-serve upgrades. At launch the super admin assigns paid plans manually.
2. Conversation inbox; analytics charts on the agent page (launch has counts only).
3. Send Email tool (SES), single-URL knowledge import, Google OAuth connections.
4. Multi-workspace UI; tenant-facing audit log page.
5. Async runs with callback webhooks; "Describe your agent" AI setup; more templates.
6. Saved test cases (lightweight evals); impersonation from admin.

**Phase 2 and later:** unchanged from §H/§I, except that WE360 product integration (§Z) waits until the shared login and other products' APIs exist.

### 0.3 Authentication (in-app now, shared login later)

- **Library:** Better Auth (TypeScript, self-hosted, data in our own Postgres). Its plugins cover organizations, invitations, roles, Google login, email verification, 2FA and admin user management (ban, revoke sessions). This saves about a week compared with building these ourselves. *Confirm the current version and plugin APIs in week 1.*
- **Hosting:** auth routes are mounted in the API service. The ALB routes `/api/*` to the API and everything else to Next.js, so the browser sees **one origin**. Cookies are httpOnly, Secure and SameSite=Lax, and there is no CORS for the app.
- **Isolation for the future:** all code depends on an `AuthProvider` interface (`getSession`, `requireUser`, `requireOrgRole`) and on our own `users`/`organizations` IDs. Users and orgs keep an `external_ref` column. When the WE360 shared login is ready:
  - Option A: Better Auth's OIDC provider plugin turns this app's auth into the shared login.
  - Option B: we add an OIDC client to the WE360 IdP, link accounts by verified email, and switch the provider.
  - Either way, agents, knowledge and logs are untouched.
- **Super admins:** `users.platform_role` (`super_admin` | `support` | null). 2FA is required for these accounts.

### 0.4 Model Keys: Platform + BYOK

- Each org has an **AI settings** page. For each provider (OpenAI, Anthropic, Gemini) it chooses **"Use platform credits"** or **"Use my own key"**.
- **BYOK keys** are stored in `credentials` (`integration_key = 'llm.openai'` etc., org-scoped) with KMS envelope encryption. A key is validated with a cheap test call on save. Only the last 4 characters are ever shown, and keys can be rotated or removed at any time.
- **Resolution at run time:** `ModelGateway.resolveKey(org, provider)` returns either the org's BYOK key or the platform key from Secrets Manager.
- **Failures:** if a BYOK key fails (invalid, or the provider's quota is exhausted), the run fails with a clear message ("Your OpenAI key was rejected"). **It never silently falls back to platform keys**, because that would create surprise costs for us.
- **Usage:** every `usage_records` row has `billing_source` = `platform` | `byok`.
  - Platform usage counts against the plan's **AI credit** budget.
  - BYOK usage is recorded (estimated cost shown to the customer) but does not use credits.
  - **Both** count against message/run limits, so plan limits still apply to BYOK users.
- **Models:** the platform model catalog is managed by the super admin, and plans restrict which tiers are allowed. BYOK orgs can use any enabled catalog model for that provider. Custom model IDs come in v1.1.

### 0.5 Plans and Limits

The plans are seeded data, editable by the super admin. **Numbers below are placeholders to confirm.**

| Limit | Free | Starter | Professional | Business | Enterprise |
|---|---|---|---|---|---|
| Agents | 1 | 3 | 10 | 25 | Custom |
| Messages (agent runs) / month | 100 | 2,000 | 10,000 | 50,000 | Custom |
| Platform AI credits / month | small trial | ✓ | ✓ | ✓ | Custom |
| BYOK | ✓ | ✓ | ✓ | ✓ | ✓ |
| Knowledge storage | 10 MB | 100 MB | 1 GB | 5 GB | Custom |
| Members | 1 | 3 | 10 | 25 | Custom |
| Model tiers | Fast | Fast, Balanced | All | All | All |
| Deploy: hosted page / widget / API | ✓ / ✓ / – | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | ✓ |
| Remove widget branding | – | – | ✓ | ✓ | ✓ |
| Log retention | 7 days | 30 days | 60 days | 90 days | Custom |

**Enforcement points:**
- Create agent / invite member / upload document: count checks in the API, returning `403` with `code: plan_limit_reached`.
- Each run: a Redis counter is checked before the run starts (messages, and credits when using platform keys). It is reconciled with `usage_records` hourly.
- Model selection is limited by tier.
- Retention is applied by a nightly worker job.

**Data:**
- `plans` (id, key, name, limits jsonb, is_public, sort)
- `organizations.plan_id`, `organizations.plan_overrides jsonb` (per-org custom limits set by the super admin), `organizations.billing_cycle_anchor`

When payments arrive (v1.1), `subscriptions` and `payments` tables are added. Nothing in enforcement changes.

### 0.6 Super Admin Dashboard

**Where:** the `/admin` route group in the same Next.js app, calling `/api/admin/v1/*`. It is guarded by `platform_role`, requires 2FA and can be restricted to an office IP list via AWS WAF. Every admin action is written to `audit_logs` with `actor_type = 'platform_admin'`. It stays in this app rather than a separate admin app to save time; it can be split out later because it already has its own API prefix.

**Roles:** `super_admin` (everything) and `support` (read-only, plus suspend agent and resend verification email).

| Page | v1.0 launch | v1.1 |
|---|---|---|
| **Overview** | Total orgs, users, active agents; runs today / 30 days; platform AI cost today / month; error rate; signups per day | Revenue (after payments), cohort charts |
| **Organizations** | Search and filter by plan or status; detail with members, agents, usage vs limits, AI settings (BYOK on/off, never the key); **change plan**, **set limit overrides**, **grant extra credits**, **suspend / reactivate** | Delete with data export; notes |
| **Users** | Search; detail with orgs and last login; **ban/unban**, **revoke sessions**, resend verification | Impersonate ("view as", read-only, audited, visible banner) |
| **Agents (all tenants)** | Search by name or org; **disable an agent or deployment** (abuse) | Content review queue |
| **Executions** | Filter by org, agent, status, model, cost; open the trace. Opening a trace's content is audited | Replay a run |
| **Usage & cost** | By provider, model, org and day; platform vs BYOK split; top spenders | Anomaly alerts |
| **Plans** | Edit plan limits | Pricing and payment plan mapping |
| **Models** | Model catalog: enable/disable, prices, tier, default model; platform key health per provider | Per-region routing |
| **Feature flags** | Global on/off and per-org overrides | Percentage rollouts |
| **System health** | API/worker status, queue depth and failed jobs (embedded queue dashboard), provider error rates, ingestion failures | Status page |
| **Audit log** | Search admin and tenant actions | Export |

**First super admin:** created by a one-time CLI seed command (`pnpm admin:create`). There is no signup path to super admin.

### 0.7 Six-Week Plan

**Team roles:**
- **E1, Tech lead / platform:** repo, CI/CD, AWS, auth, tenancy/RLS, security.
- **E2, AI runtime:** ModelGateway, BYOK, runtime loop, tools, SSRF guard.
- **E3, Data:** worker, knowledge/RAG, usage metering, plan enforcement, retention.
- **E4, Frontend product:** shell and design system, agent builder, playground/trace, knowledge and tools UI.
- **E5, Full-stack:** super admin dashboard, deployments (hosted page, widget, API keys), logs and usage pages.

| Week (2026) | Goal | Deliverables | End-of-week check |
|---|---|---|---|
| **W1** Oct 5–9 | Foundation | Repo and CI; docker-compose local stack; AWS staging (ECS web/api/worker, RDS with pgvector, ElastiCache, S3, KMS, ALB path routing); DB schema v1 + RLS; Better Auth (email, Google, orgs, invites); app shell + design system; ModelGateway spike with 3 providers; **request SES production access** (it can take days) | Sign up, create org, invite member on staging; cross-tenant isolation tests pass |
| **W2** Oct 12–16 | Agents + runtime | Agent CRUD, draft/publish/restore; builder tabs Identity/Instructions/Model; runtime loop with limits and streaming; executions/steps/usage records; playground v1 with trace; BYOK settings + key validation; super admin skeleton + seed command | Create an agent, chat with it in the playground on platform or BYOK key, see the trace and cost |
| **W3** Oct 19–23 | Tools + knowledge ingestion | Tool registry/executor; Custom HTTP tool + credentials (KMS) + SSRF guard; Tools tab; ingestion worker (parse → chunk → embed → store); knowledge UI with upload status | Agent calls an external API safely; documents reach "ready" |
| **W4** Oct 26–30 | Retrieval + deploy | Hybrid retrieval + Knowledge Search tool + citations; API keys + runs API (sync/stream); hosted chat page; widget v1 (origins, theme); conversations | Agent answers from documents with citations on a public page, a widget on a test site and via API |
| **W5** Nov 2–6 | Plans + admin + polish | Plans/limits enforcement + Usage page; super admin pages (Overview, Orgs, Users, Agents, Executions, Usage, Plans, Models, Flags, Health, Audit); executions UI; 3 templates; rate limits; retention job. **Feature freeze Friday** | Every v1.0 row in §0.2 works end to end on staging |
| **W6** Nov 9–13 | Harden + launch | Security pass (prompt-injection set, SSRF tests, isolation tests, dependency scan), k6 load test, backup/restore drill, Sentry alerts, production environment, runbook, legal pages (terms, privacy, DPDP), bug bash | Launch checklist signed; production live for beta (week of Nov 16) |

**Schedule risk:** Diwali falls in W6 (Sunday Nov 8, 2026). Check team leave now. If leave overlaps, plan the launch for the week of Nov 23 or move the hardening work earlier.

**Rules that keep six weeks realistic:**
- Feature freeze at the end of W5. Anything not done moves to v1.1, not into W6.
- Use ready-made pieces: shadcn/ui, Better Auth, AI SDK, BullMQ's dashboard, a pgvector hybrid-search SQL pattern.
- Deploy to staging every day from W1. No "integration week" at the end.
- E2E tests (Playwright) only for the critical paths: sign up, create agent, upload doc, chat, publish, widget, plan limit.
- Engineers test each other's features. No dedicated QA is assumed.

### 0.8 Repository (standalone)

```
workeasy360-agents/            (independent repo, pnpm workspace + Turborepo)
├── apps/
│   ├── web/        Next.js: product UI + /admin super admin + hosted chat page
│   ├── api/        Express 5: REST API, auth routes, admin API
│   ├── worker/     BullMQ: ingestion, usage reconcile, retention
│   └── widget/     embeddable chat widget bundle
├── packages/
│   ├── agent-runtime/  ai-gateway/  tools/  knowledge/
│   ├── db/  contracts/  auth/  ui/  config/
├── infra/terraform/   docs/   docker-compose.yml
```
Packages stay internal. When other WE360 products want shared UI or auth, `ui`, `auth` and `contracts` can be published to a private npm registry without restructuring.

**Backend framework (decided 2026-10-02):** **Node.js + Express 5**. NestJS and Fastify are not used. Structure comes from convention: one folder per module under `apps/api/src/modules/<name>/` (routes, service, schemas), with shared middleware for session, tenant and role checks. Express 5 forwards async errors to the error handler, so handlers need no wrappers.

### 0.9 Schema changes from §S

- **Better Auth tables** (user, session, account, verification, organization, member, invitation) are mapped onto our `users`, `organizations` and `memberships` with UUID IDs. Session, account and verification tables are added.
- `users.platform_role` is added.
- **New tables:** `plans`, plus the org columns in §0.5. `feature_flags` (key, default_enabled, org_overrides jsonb) is now a table.
- **Changed tables:** `usage_records.billing_source`; `credentials` also holds org-scoped BYOK keys (workspace_id nullable); `deployments.channel` adds `hosted_page` and removes `internal` for now.
- **Not changed:** agents, versions, tools, knowledge, executions, conversations, audit.

### 0.10 Remaining Questions

1. **Plan numbers and prices:** are the placeholders in §0.5 acceptable? What are the prices in ₹?
2. **Paid plans at launch:** OK to assign them manually from the super admin until Razorpay lands in v1.1?
3. **Platform keys:** which provider accounts (OpenAI, Anthropic, Google) exist, and with what monthly spending caps?
4. **Domain and branding:** app domain (e.g., `agents.workeasy360.com`), product name, logo and colors?
5. **Launch type:** public beta or general availability?
6. **Infrastructure tooling:** Is Terraform already used in your AWS account? (Backend framework resolved: Express.)

---

## A. Executive Summary

- **What we build:** A multi-tenant, provider-agnostic **agent platform**. An *Agent* is a versioned configuration (instructions + model + tools + knowledge + memory policy + guardrails). A single, bounded **tool-calling runtime** executes it. Agents are deployed through channels (web widget, API, embedded in WorkEasy360 products).
- **Core insight from research:** Every serious platform has converged on the same core loop: an LLM with function calling, a tool registry, RAG and conversation memory, plus a test playground and traces. The real differences are in **governance** (versions, approvals, evals, cost control), **integration depth**, and **builder UX**. Visual workflow canvases (n8n, Dify, Langflow, Flowise, Copilot Studio) are valuable, but they are a *second* abstraction layered on top of the agent runtime. They should not be the foundation.
- **Phase 1 recommendation:** A **config-based agent builder** (tabbed form plus a live playground side by side). Add an optional "describe your agent" AI-assisted setup. No visual canvas in Phase 1, but the runtime is designed so a Phase 2 workflow engine can call the agent as a node.
- **Stack:** TypeScript end to end.
  - Frontend: Next.js.
  - API: Node.js + **Express 5** as a **modular monolith** (decided in v0.2).
  - Background jobs: a worker process from the same codebase, using BullMQ on Redis.
  - Data: PostgreSQL 16 with **pgvector** (no separate vector DB), S3 for files.
  - Models: Vercel AI SDK, wrapped in our own `ModelGateway`.
  - Hosting: AWS (ECS Fargate, RDS, ElastiCache, S3, CloudFront).
  - **No Python service in Phase 1.**
- **Non-negotiables from day one:**
  - Tenant isolation: `org_id` on every row, plus Postgres RLS as a second line of defense.
  - Immutable agent versions with draft/publish.
  - Encrypted credentials (KMS envelope encryption).
  - Execution traces and per-call token/cost records.
  - Hard execution limits (steps, time, tokens).
  - SSRF-safe HTTP tool.
- **Deliberately postponed:** visual workflow canvas, multi-agent orchestration, long-term memory, voice, WhatsApp/Slack channels, MCP client, marketplace, SSO/SCIM, complex billing, fine-tuning, self-hosting.
- **Rough size:** The full Phase 1 (M0–M10) is about 18–22 weeks for 4–6 engineers. **Given the 6-week launch, a reduced v1.0 ships first (§0.2), and the rest becomes the v1.1+ roadmap.**

---

## B. Product Vision

> *"Every WorkEasy360 customer can hire an AI teammate in minutes. It knows their business, uses their tools, and works across every WorkEasy360 product, safely and within budget."*

Lifecycle: **Create → Configure → Connect → Test → Deploy → Monitor → Improve.**

Five-year arc:
1. **Phase 1:** single agents with tools and RAG, deployed to web/API.
2. **Phase 2:** workflows (visual canvas) with agent nodes, more channels (WhatsApp, Slack, email), MCP, long-term memory, evals.
3. **Future:** multi-agent teams, a cross-product AI layer (agents act across all WorkEasy360 products), marketplace for templates/tools, voice, enterprise governance.

---

## C. Target Users

| Persona | Needs | Skill | Phase 1 priority |
|---|---|---|---|
| SMB owner / operator | "Answer my customers, qualify leads" from templates | Non-technical | **Primary** |
| Support / sales / marketing teams | FAQ bot on docs, CRM lookup, lead capture | Non-technical | **Primary** |
| WorkEasy360 product users | AI inside the product they already use | Non-technical | Later (the app is standalone at launch; see §0.1) |
| Agencies | Build and manage agents for many clients | Semi-technical | Secondary (needs multi-workspace; Phase 1 supports workspaces) |
| Developers | API, custom HTTP tools, webhooks | Technical | Secondary (API + HTTP tool in Phase 1) |
| Enterprise internal teams | SSO, audit, governance, data residency | Mixed | Phase 2+ |
| WorkEasy360 product teams (internal) | Expose their product as tools; embed agents | Engineers | **Primary** (platform contract) |

**What a user must NOT need to know:** embeddings, chunking, vector DBs, prompt engineering techniques, model API differences, token math, JSON Schema, OAuth flows, retry semantics. They pick a template, write plain-English instructions, upload docs, tick tools, connect accounts, test, and publish.

**What the platform does for the example** ("handle customer queries, check CRM, use company docs, decide, respond"):

| Requirement | Platform feature |
|---|---|
| Handle incoming queries | Channel deployment (web widget/API) |
| Check CRM | Tool (WorkEasy360 CRM tool or HTTP tool) with credential |
| Use company documents | Knowledge base (RAG) |
| Decide what to do | Runtime tool-calling loop guided by instructions |
| Respond | Streaming response to the channel |
| Afterwards | Trace, cost and analytics |

---

## D. Competitor / Reference Research

### D.1 Platform findings

| Platform | Key feature | Why it exists | Do we need it? | Phase |
|---|---|---|---|---|
| **n8n** | Node canvas with trigger→action graph; **AI Agent node** with sub-nodes for *Model*, *Memory* (window/buffer/vector/Postgres) and *Tools* (any node as a tool, vector store as a tool) | Puts AI inside deterministic automation; reuses its 400+ integration nodes | The canvas and trigger model, yes. The "agent = node with pluggable model/memory/tools" pattern is exactly our runtime contract | Canvas: **P2**; pattern: **P1** |
| n8n | Credentials as separate encrypted entities, referenced by nodes and shareable | Separates secrets from logic; reusable | Yes | **P1** |
| n8n | Execution history with per-node input/output, retry, error workflows | Debugging and trust | Yes (per-step traces) | **P1** traces; error workflows **P2** |
| n8n | Expressions `{{ $json.x }}`, variables, Code node | Data mapping without code | Templated variables in instructions only | Variables **P1** (simple); expressions/code **P2** |
| n8n | Webhook/schedule triggers | Event-driven automation | Webhook-triggered agent run via API | API/webhook **P1**; schedule **P2** |
| **Zoho Zia Agent Studio** | No-code builder: name, icon, role, **model choice**, knowledge (upload/WorkDrive/URL), tools from 700+ Zoho actions; **"Create with Zia" prompt-based generation**; sandbox testing; **version control with rollback**; RBAC; "digital employee" deployment; agent marketplace; MCP; build free, pay for model usage or **BYOK** | Ecosystem-native agents that act across a suite (the closest analogue to WorkEasy360) | Yes: the ecosystem tool catalog, versioning, prompt-generated agents, BYOK | Ecosystem tools **P1** (1–2 products); prompt-gen **P1 Should**; marketplace **Future**; BYOK **P2** |
| **SailoAI** (independent platform) | AI sales/support agents, AI inbox agent, "AI Brain" (knowledge), workflow builder, CRM, WhatsApp WABA, email sequences; tiered by number of bots | SMB growth automation | Reference for SMB packaging: plan tiers by number of bots, WhatsApp-first channels and knowledge as an "AI Brain". No integration | Reference only |
| **Dify** | Agent app (function calling / ReAct) plus Workflow and Chatflow canvases; built-in RAG pipeline (upload→chunk→embed→retrieve, hybrid search, rerank); per-node debug; variables; 50+ tools; plugin system | Open-source LLM-app platform | RAG settings UX, per-node debugging, the "agent app vs workflow app" split | Agent app **P1**; workflow **P2** |
| **Relevance AI** | Agents + Tools (tools are themselves mini multi-step automations) + Knowledge; **approval modes per tool** ("Approval required" / "Let agent decide"); escalation on max retries; "Workforce" multi-agent | Governed GTM automations | Per-tool approval flag and escalation, yes. Workforce, later | Approval flag modeled in **P1**, enforced UX **P2**; multi-agent **Future** |
| **Microsoft Copilot Studio** | Generative orchestration (LLM picks topics/tools/knowledge/agents); authoring modes **Build / Preview / Evaluate / Monitor**; **agent evaluation** with test sets and multi-turn tests (GA 2026); governance and DLP | Enterprise agents on Power Platform | The four-mode IA is excellent; evals are needed for quality at scale | Build/Preview/Monitor **P1**; Evaluate **P2** |
| **Salesforce Agentforce** | **Topics** (scope + instructions + actions); Atlas reasoning loop (reason→act→observe); **Einstein Trust Layer** (PII masking, zero data retention, toxicity checks, audit) | Precision and trust at enterprise scale | Topics-like scoping later; trust layer concepts (PII redaction, ZDR contracts, audit) | Audit/limits **P1**; PII masking **P2**; topics **P2** |
| **OpenAI AgentKit** | Agent Builder canvas, ChatKit embeddable chat, Guardrails, Evals. **Agent Builder and Evals are being wound down on the OpenAI platform (Nov 30, 2026)**; ChatKit and Agents SDK remain | Vendor-hosted agent building | **Lesson: do not depend on a vendor's hosted agent builder.** Build on plain model APIs behind our own abstraction. ChatKit-style embeddable widget is a good pattern | Widget **P1** |
| **Langflow / Flowise** | Open-source LangChain-based canvases; components as nodes; export as API | Developer prototyping | Canvas component model is useful reference; their LangChain coupling is a warning (abstraction churn) | Reference for **P2** |
| **Vercel AI SDK 6** (library) | Unified provider API (`generateText`/`streamText`), Zod tool schemas, `ToolLoopAgent` with step limits, MCP client, UI streaming | Provider-agnostic TS AI layer | Yes, as the implementation behind our `ModelGateway` | **P1** |
| **MCP** (protocol) | Standard tool/server protocol, adopted by Zoho, OpenAI, Anthropic, Microsoft | Interoperable tools | Our tool schema aligns with MCP (name/description/JSON Schema). MCP **client** (consume external servers) **P2**; expose WorkEasy360 as MCP **server** **Future** | **P2/Future** |

### D.2 Problems existing platforms solve poorly (our opportunity)

1. **Canvas-first complexity:** n8n, Dify and Langflow overwhelm non-technical users. Start config-first and add the canvas when needed.
2. **Weak cost governance:** few SMB platforms show per-agent cost or enforce budgets. Make cost a first-class metric and quota.
3. **Opaque failures:** users can't tell *why* an agent answered wrongly. Show retrieved chunks and tool calls in the playground.
4. **Fragile vendor dependence:** OpenAI's Agent Builder shutdown, LangChain churn. Thin, owned abstraction.
5. **Ecosystem silos:** agents bolted onto one product. WorkEasy360 can offer one AI layer across all products, like Zoho.
6. **Draft/production confusion:** edits go live instantly. Use immutable versions and explicit publish.

---

## E. Feature Comparison

| Capability | n8n | Zoho Zia | Dify | Relevance | Copilot Studio | Agentforce | **WE360 P1** | **WE360 P2+** |
|---|---|---|---|---|---|---|---|---|
| Config/form agent builder | – | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Prompt-generated agent | – | ✓ | partial | ✓ | ✓ | ✓ | Should | ✓ |
| Visual workflow canvas | ✓ | ✓ | ✓ | partial | ✓ | partial | – | **✓** |
| Templates | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (5–8) | marketplace |
| Multi-provider models | ✓ | ✓ | ✓ | ✓ | partial | partial | **✓** | |
| BYOK | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| RAG (files/URLs) | via nodes | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** files+text+URL | crawl, connectors |
| Hybrid search / rerank | – | ? | ✓ | ? | ✓ | ✓ | ✓ hybrid | rerank |
| Custom HTTP tool | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Native ecosystem tools | ✓ | ✓✓ | – | – | ✓✓ | ✓✓ | ✓ (1–2 WE360 products) | all products |
| MCP | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Short-term memory | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Long-term memory | partial | ✓ | partial | ✓ | partial | ✓ | – | ✓ |
| Playground + traces | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Versioning / rollback | partial | ✓ | partial | ✓ | ✓ | ✓ | **✓** | diff, staged rollout |
| Evals | ✓ | ? | partial | ✓ | ✓ | ✓ | – | ✓ |
| Human approval | ✓ | ? | ✓ | ✓✓ | ✓ | ✓ | flag only | ✓ |
| Web widget | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| WhatsApp/Slack | ✓ | ✓ | plugin | ✓ | ✓ | ✓ | – | ✓ |
| Cost tracking/quotas | – | ✓ | partial | ✓ | ✓ | ✓ | **✓** | billing |
| Multi-agent | ✓ | ✓ | partial | ✓ | ✓ | ✓ | – | Future |

---

## F. Proposed Feature Set (full product)

Organized by product area. Phase tags are in §G–I.

1. **Workspace & Identity:** orgs, workspaces, members, roles, API keys, audit log, SSO (later).
2. **Agent Studio:** templates, AI-assisted setup, identity, instructions, model, knowledge, tools, memory, guardrails, versions.
3. **Knowledge:** knowledge bases, sources (file/text/URL/crawl/connectors), ingestion status, chunk preview, retrieval settings.
4. **Tools & Connections:** tool catalog, custom HTTP tools, WorkEasy360 tools, credentials/connections, MCP servers (later).
5. **Playground:** chat, trace panel, retrieved sources, tool I/O, reset, compare versions (later).
6. **Deployments:** web widget, API, internal embed; later WhatsApp, Slack, email, voice.
7. **Conversations & Logs:** conversation inbox, execution traces, filters.
8. **Analytics:** volume, success, latency, tokens, cost, tool usage.
9. **Workflows (Phase 2):** canvas, triggers, logic nodes, agent node, run history.
10. **Governance:** quotas, approvals, PII masking, evals, retention.
11. **Admin (internal):** tenants, usage/cost, model catalog, feature flags, suspensions.

---

## G. Phase 1 Scope (MVP)

### Must Have
- Auth via WorkEasy360 identity (see Q2), **organization + workspace**, roles (Owner/Admin/Builder/Viewer).
- Agent CRUD, duplicate, disable, soft-delete; **draft + publish immutable versions; rollback** (re-point to an older version).
- Agent config: name, description, avatar, role, tone, instructions (with simple `{{variables}}`), model selection, temperature/max tokens, welcome message, fallback message.
- **ModelGateway** with at least 2 providers (OpenAI and Anthropic; Gemini if cheap to add) and a platform-managed model catalog with prices.
- **Runtime:** bounded tool-calling loop; streaming; limits on steps, time and tokens; retries on provider errors; provider fallback (optional per model).
- **Tools:** framework plus built-ins:
  - Knowledge Search (auto-attached when knowledge is linked)
  - Custom HTTP Request tool (SSRF-safe)
  - Send Email (platform SES)
  - **One WorkEasy360 product tool pack** (e.g., CRM: lookup/create contact) via the internal tool contract
- **Credentials:** API-key/bearer/basic auth types, KMS-encrypted. (OAuth2 connections are a Should.)
- **Knowledge:** KBs; upload PDF/DOCX/TXT/MD/CSV, paste text, single URL fetch; async ingestion; pgvector **hybrid** retrieval; citations.
- **Memory:** conversation history with token-window trimming.
- **Playground:** streaming chat, trace panel (steps, tool calls with I/O, retrieved chunks, tokens, latency, errors), reset, test draft vs published.
- **Deployments:** REST API (API keys, sync + streaming); **web chat widget** (embed snippet, allowed domains, theme); internal embed SDK for WorkEasy360 products.
- **Execution logs:** executions + steps, filterable list and detail view; retention 30–90 days by plan.
- **Usage tracking:** per-call tokens and cost; org monthly token/cost quota and rate limits (hard stop with a clear error).
- **Audit log** for config, credential, member and deployment changes.
- **Internal admin:** orgs/users list, usage and cost by org, suspend org, model catalog management, feature flags.
- Basic analytics on the agent page: executions, success rate, p50/p95 latency, tokens, cost, top tools (last 7/30 days).

### Should Have
- "Describe your agent" AI-assisted setup (generates instructions and suggests tools/template).
- OAuth2 connections for 1–2 providers (Google: Gmail/Calendar).
- Conversation inbox (read past conversations per agent).
- User feedback (👍/👎) on widget and playground responses.
- Starter templates (5–8): Support FAQ, Lead qualifier, Appointment booker, Internal HR/IT helpdesk, Product expert, Sales assistant.
- Basic input guardrails: max input size, blocked topics list, simple PII redaction in logs.

### Could Have
- Gemini plus one open-weights model (via Bedrock/Groq/Together) for cost tiers.
- Side-by-side version comparison in the playground.
- Website crawl (sitemap-limited, about 50 pages).
- Org-level spending alerts (email at 80% and 100%).

### Future → §H, §I

---

## H. Phase 2 Scope

- **Workflow engine + visual canvas** (React Flow): triggers (manual, webhook, schedule, WE360 event), AI Agent node, LLM/Classifier/Extractor nodes, If/Switch, HTTP, Set/Transform, Send message; run history per node.
- Channels: **WhatsApp** (reuse SailoAI WABA integration), Slack, Email inbound.
- **MCP client** (attach external MCP servers as tool sources).
- **Human-in-the-loop:** tool approval requests, escalation to human inbox, handoff.
- **Long-term memory** (per end-user facts, pgvector).
- **Evals:** test sets, multi-turn tests, regression runs on publish, LLM-as-judge.
- BYOK model keys; more providers; reranking; connectors (Google Drive, Notion, SharePoint) with sync.
- PII masking before the model (trust layer), retention policies per org.
- Plan-based billing integration with WorkEasy360 shared billing.
- SSO (SAML/OIDC) via shared identity; SCIM later.
- Topic/scoped instructions (Agentforce-style) for complex agents.

## I. Future Scope

Multi-agent teams/supervisor patterns, A2A interop, voice agents, agent and template marketplace, third-party tool plugins (signed packages), WorkEasy360-wide MCP server, self-hosted/on-prem runtime, fine-tuning/custom models, advanced autonomous planning, mobile app, data residency per region, cross-product event-driven automations.

### Explicitly NOT in Phase 1 (with reason)

| Not building | Reason / dependency |
|---|---|
| Visual workflow canvas | Needs the runtime, tools and execution engine to be stable first; most SMB use cases are covered by single agents |
| Multi-agent | Depends on mature single-agent runtime and evals; multiplies cost and debugging complexity |
| Autonomous planning | The tool loop with limits covers about 90% of cases; planners add cost and unpredictability |
| Long-term memory | Privacy/consent design needed; low value before conversations exist |
| WhatsApp/Slack/Email channels | Channel abstraction is built in P1; adapters are additive in P2 |
| MCP client | Security model for third-party servers needs thought; HTTP tool covers P1 |
| Marketplace | Needs tenants, templates and a review process |
| SSO/SCIM, complex billing | Ecosystem-level concerns; use shared services once they exist |
| Voice, fine-tuning, self-hosting | Different infrastructure and economics |
| Evals framework | P2. P1 relies on playground and feedback (the data model already supports it) |
| Kubernetes, microservices, event bus | No clear reason at P1 scale (see §W) |

---

## J. User Journeys

**J1: Business user creates a support agent (the core journey)**
1. Agents → **New agent** → pick template "Customer Support" (or "Describe your agent" → AI drafts config).
2. **Identity** tab: name, avatar, role, tone (pre-filled).
3. **Instructions** tab: editable plain English with guidance hints.
4. **Model** tab: "Balanced (recommended)" / "Fast & cheap" / "Most capable", with raw model choice under Advanced.
5. **Knowledge** tab: create KB → upload PDFs → watch ingestion status → preview chunks.
6. **Tools** tab: enable "Look up CRM contact" (WE360 CRM) → pick connection.
7. **Playground** (always visible on the right): chat, expand trace to see sources and tool calls.
8. **Publish v1** with a change note.
9. **Deploy** → Web widget → copy snippet, set allowed domain.
10. **Monitor:** agent overview shows conversations, success, cost; logs drill-down.
11. **Improve:** edit draft → test → publish v2 → widget picks up v2 (deployments track "latest published" by default; can be pinned).

**J2: Developer calls the agent via API.** Create API key (workspace-scoped) → `POST /v1/agents/{id}/runs` (sync or `stream=true`) with `conversation_id` → view the run in logs.

**J3 (future, after the WE360 shared login exists): WorkEasy360 product embeds an agent.** The product backend gets a service token → calls the platform API on behalf of the user (token exchange) → embeds `@we360/agent-chat` component → agent tools call back into the product's API with the user's permissions.

**J4: Admin investigates a cost spike.** Admin panel → Usage by org → agent → executions sorted by cost → trace shows a looping tool → lower the agent's step limit or suspend.

---

## K. Product Information Architecture

```
WorkEasy360 shell (shared nav, org switcher)
└── AI Agents
    ├── Home (overview, recent agents, usage this month)
    ├── Agents
    │   └── Agent
    │       ├── Build      (Identity · Instructions · Model · Knowledge · Tools · Memory · Guardrails) + Playground pane
    │       ├── Deploy     (Widget · API · Embedded)
    │       ├── Monitor    (Overview analytics · Conversations · Executions)
    │       ├── Versions   (list, publish notes, rollback)
    │       └── Settings   (limits, danger zone)
    ├── Knowledge (KBs → sources → chunks)
    ├── Tools & Connections (catalog · custom tools · connections/credentials)
    ├── Logs (all executions, filter by agent/status/channel)
    ├── Usage (tokens, cost, quota)
    └── Settings (workspace, members & roles, API keys, audit log)
Internal Admin (separate app): Orgs · Users · Usage & Cost · Models · Feature flags · System health
```
The Build / Deploy / Monitor split follows Copilot Studio's Build / Preview / Evaluate / Monitor modes, adapted (Preview is the always-on playground pane; Evaluate comes in Phase 2).

---

## L. Agent Architecture

**Definition:** An **Agent** is a named, tenant-owned, *versioned configuration* that, given a conversation and an input, uses an LLM to produce a response, optionally retrieving knowledge and calling tools, within declared limits. An agent has **no code and no graph** in Phase 1.

| Component | What it is | Phase 1 |
|---|---|---|
| Identity | name, avatar, role, tone, description | ✓ |
| Instructions | system prompt assembled from role + tone + instructions + guardrail text + variables | ✓ |
| Model | `{model_id, params, fallback_model_id?}` resolved via catalog | ✓ |
| Memory | policy: history window (N turns / token budget), summarization off/on | ✓ window only |
| Knowledge | linked KBs + retrieval settings (top_k, min score, mode=auto-tool or always-inject) | ✓ |
| Tools | linked tool instances + per-binding settings (enabled, approval flag, overrides) | ✓ |
| Integrations | indirectly, via tools' connections | ✓ |
| Guardrails | limits (steps, tokens, timeout), input size, blocked topics, output disclaimers | ✓ basic |
| Decision logic | delegated to the LLM via instructions + tool descriptions (no graph) | ✓ |
| Workflow logic | Phase 2 workflow engine; an agent can be a node | – |

**Knowledge mode:** default is **"auto"** (knowledge search exposed as a tool; the model decides). Option **"always"** retrieves top-k for every user turn and injects it into context. "Always" is better for FAQ bots on weaker models; "auto" is better for multi-purpose agents. Dify and Relevance offer the same choice.

---

## M. Agent Runtime Architecture

**Recommendation:** a **bounded ReAct-style tool loop** (native function calling, not text-parsed ReAct), implemented as a pure TypeScript package (`packages/agent-runtime`) with no HTTP or DB dependencies. Everything it needs is injected through ports:

```ts
interface RuntimePorts {
  models: ModelGateway;          // generate/stream with tools
  tools: ToolExecutor;           // resolves + executes tool calls (with creds, SSRF guard, timeout)
  knowledge: Retriever;          // hybrid search over linked KBs
  memory: ConversationStore;     // load/append messages
  tracer: ExecutionTracer;       // steps, tokens, cost
  limits: LimitsPolicy;          // quotas pre-check, step/token/time budgets
}
runAgent(agentVersionSnapshot, input, context, ports): AsyncIterable<RuntimeEvent>
```

**Loop:**
1. Resolve the agent version.
2. Pre-flight: quota and rate check.
3. Build context: system prompt + memory window + (if "always") retrieved chunks.
4. Call the LLM with tool schemas.
5. If there are tool calls: validate the args against the schema, check permission and approval flag, execute in parallel (each with its own timeout), add the results, and repeat.
6. Stop on a final answer, or when `maxSteps` (default 6, max 15) / `maxTokens` / `timeout` (60s interactive, 5 min async) is hit.
7. Persist messages, steps and usage; emit events.

| Concept | Needed in P1? | Decision |
|---|---|---|
| Agent loop + tool calling | Yes | Core |
| Planning (plan-then-execute) | No | Future, as an optional strategy |
| ReAct (text) | No | Native function calling is more reliable |
| State machine | Implicitly | The run status machine: `queued→running→succeeded/failed/cancelled/limited` |
| Graph execution | No | Phase 2 workflow engine |
| Human approval | Data model only | `requires_approval` on binding → P1 behavior: tool returns "needs approval" to the model; full pause/resume in P2 |
| Max steps / timeout / token budget | Yes | Hard limits, plan-capped |
| Retry | Yes | Provider calls: exponential backoff on 429/5xx (max 2), optional fallback model. Tools: no automatic retry for non-idempotent (POST) unless configured |
| Error handling | Yes | Tool errors are returned to the model as structured errors (it can recover); fatal errors end the run with a user-safe fallback message |

**Streaming events** (SSE): `run.started`, `step.started`, `text.delta`, `tool.call`, `tool.result`, `retrieval.result`, `step.completed`, `run.completed`, `run.failed`. The playground receives everything; public channels only receive `text.delta`, `run.completed` and (optionally) citations.

---

## N. Workflow Architecture (Agent vs Workflow; execution engine)

- **Agent** = goal-directed; the LLM decides the path at runtime; non-deterministic.
- **Workflow** = a deterministic graph authored by a human; the steps are known; it may *contain* AI steps (including an Agent node).

**Phase 1 needs agents only.** But we need an **execution engine** for async work regardless:

| Work | P1 mode | Why |
|---|---|---|
| Playground / widget chat | **Synchronous streaming** in the API process | Latency; user is waiting |
| API runs `stream=false` short | Sync with 60s cap | Simple for developers |
| API runs `async=true` / webhook-triggered | **Queue → worker**, result via polling or callback webhook | Long tool chains, retries |
| Document ingestion, URL fetch, embeddings | **Queue → worker** | Slow, CPU/IO heavy, retryable |
| Usage rollups, retention cleanup | Scheduled job (BullMQ repeatable) | Background |

So **Redis + BullMQ are needed in Phase 1**, mainly for ingestion. The same `runAgent` is called from both the API and the worker.

**When to split further:** move interactive runs out of the API process into dedicated runtime workers (streaming via Redis pub/sub) when API latency or CPU suffers. Expected triggers: around 50 concurrent runs per instance, or when workflows arrive.

**Phase 2 workflow engine design (planned now so P1 does not block it):**
- Workflow definitions are stored as a versioned JSON graph (`nodes[]`, `edges[]`; each node has `type`, `version` and `params`) in the same versioning pattern as agents.
- An executor walks the graph, persists per-node runs into the same `executions`/`execution_steps` tables (`kind='workflow'`), and runs as BullMQ jobs with per-node retry.
- Evaluate **Temporal / Restate / Inngest** at that point if long waits (human approval, delays of days) are needed. Do not adopt one in P1.

Minimum useful node set for P2 (MVP canvas):
- Triggers: Manual, Webhook, Schedule, WE360 Event
- AI: Agent, LLM Prompt, Classifier, Extractor
- Logic: If, Switch
- Actions: HTTP Request, Send Email, Send Message (channel), WE360 action
- Data: Set/Transform

Loops, Code node and sub-workflows come later.

---

## O. Tool Architecture

Three layers (n8n/Relevance/MCP-aligned):

1. **ToolProvider (code, in the registry):** a manifest plus a handler, shipped in `packages/tools/*`. Example: `http_request`, `send_email`, `knowledge_search`, `we360.crm`. It declares its operations.
2. **Tool (DB row, `tools`):** a workspace-configured instance of a provider operation. It holds the name and description the model sees, the input schema (fixed or user-defined for HTTP), static config (URL template, method, headers) and an optional `connection_id`.
3. **Agent binding (`agent_version_tools`):** which tools a version uses, plus per-binding overrides (`requires_approval`, description override).

```ts
interface ToolProviderManifest {
  key: 'http_request' | 'we360.crm' | string;  version: string;
  operations: Array<{
    key: string;                       // 'lookup_contact'
    displayName: string; description: string;   // model-facing default
    inputSchema: JSONSchema7; outputSchema?: JSONSchema7;
    sideEffect: 'read' | 'write';      // drives approval defaults + retry policy
    auth?: { integrationKey: string; scopes?: string[] };
    timeoutMs?: number;
  }>;
  configSchema?: JSONSchema7;          // per-tool static config
}
type ToolHandler = (ctx: ToolContext /* tenant, user, credential, config, signal */, input: unknown) => Promise<ToolResult>;
```

- **Registration:** providers self-register in a `ToolRegistry` at boot (plugin pattern). Adding a provider means adding a package. **The runtime never changes.**
- **Schema format:** JSON Schema, the common format of OpenAI, Anthropic, Gemini and MCP. It is converted for each provider in the gateway.
- **Output:** results are truncated and summarized to a max size (e.g., 8 KB) before going back to the model. The full result goes to the trace (redacted).
- **Executor:** validates input (Ajv) → checks the binding is enabled for this version → decrypts credential (only in memory) → applies egress policy (SSRF guard) → timeout → structured result or error.
- **MCP (P2):** an `mcp` provider maps each remote MCP tool to a dynamic operation, so the same pipeline is used.

---

## P. Integration Architecture

`Integration (definition: e.g., "Google", "WE360 CRM", "Generic HTTP")` → `Connection/Credential (tenant's authenticated account)` → `Tool (operation using that connection)` → `Agent (binds tools)`.

- **Integration** = a static definition in code: auth type (`api_key`, `bearer`, `basic`, `oauth2`, `we360_internal`), OAuth endpoints and scopes, and a test-connection function.
- **Connection** (`credentials` table) = encrypted secret material plus metadata. It is scoped to a workspace (shareable across agents in that workspace) and owned by its creator. P1: API key / bearer / basic / custom header. Should: OAuth2 (authorization code + PKCE, refresh token rotation handled by a worker job).
- **Storage:** envelope encryption.
  - Each org gets a data key, generated with AWS KMS `GenerateDataKey` and stored encrypted.
  - Secrets are encrypted with AES-256-GCM; ciphertext, IV and key-version go into the DB.
  - Plaintext is never returned by any API (only `last4` and a status are shown), never logged, and decrypted only inside `ToolExecutor` per call.
  - Rotation: re-encrypt by key version.
- **Adding third-party integrations later:** a new package with an integration definition plus a tool provider. Later still, signed third-party plugins or MCP servers. Avoid "integration platform" sprawl: consider embedding a unified-API vendor (Nango, Merge, Composio) for long-tail apps in P2 rather than building 200 connectors. This is a decision for P2.

---

## Q. Knowledge / RAG Architecture

**Pipeline (worker):**
1. **Upload to S3** (`org/{org}/kb/{kb}/{doc}`).
2. **Parse:**
   - PDF: `unpdf`/pdf.js text layer
   - DOCX: `mammoth`
   - HTML/URL: fetch via SSRF guard, then readability, then markdown
   - CSV: row groups
   - TXT/MD: as-is
3. **Normalize to markdown.**
4. **Chunk:** structure-aware recursive splitter (headings → paragraphs), about 500–800 tokens, 10–15% overlap. Heading path is kept as chunk metadata.
5. **Embed** in batches through the gateway embedding API (default `text-embedding-3-small`, 1536 dims; the model is recorded per KB).
6. **Upsert** into `document_chunks` (vector + `tsvector`).
7. **Mark the document `ready`.** Status stream: `queued→parsing→embedding→ready|failed`.

**Retrieval:** hybrid search: pgvector cosine top-k (HNSW) **plus** Postgres full-text (`ts_rank`), fused with **Reciprocal Rank Fusion**. Filters: `kb_id IN (...)` and `org_id`. Results return chunk text, document title and source for citations. A reranker (Cohere/Voyage/bge) is P2. Scanned PDFs/OCR and complex tables are P2 (Docling/Textract via a Python job or managed service).

**Vector store comparison:**

| Option | Cost | Ops overhead | Scale | Multi-tenancy | Quality | WE360 fit |
|---|---|---|---|---|---|---|
| **Postgres + pgvector** (HNSW, iterative scans in 0.8+) | Lowest (already paying for RDS) | None extra; same backups, RLS, transactions | Comfortable to ~10–50M vectors on one well-sized instance; partition/shard beyond | **Row-level, same RLS as other data**; joins with docs/permissions | Good; hybrid search with FTS in the same query | **Best**: one DB, one backup, one security model |
| Pinecone | Usage-based, grows quickly | Low (SaaS) but another vendor/DPA | Very high | Namespaces | Very good | Extra data egress and residency concerns |
| Qdrant | Self-host cheap / cloud moderate | Medium | High | Payload filters/collections | Very good, strong filtering | Good P3 candidate if pgvector saturates |
| Weaviate | Moderate | Medium–high | High | Native multi-tenancy | Good, built-in hybrid | Overkill now |
| OpenSearch | High (cluster) | High | High | Index/filters | Strong BM25 + kNN | Only if we also need log/search analytics |
| AWS S3 Vectors / Bedrock KB | Cheap storage | Low | High | Per index | Fine; less control | Lock-in; less control over chunking/hybrid |

**Recommendation:** **pgvector**. Isolate retrieval behind a `VectorIndex` interface in `packages/knowledge` so moving large tenants to Qdrant later is a contained change. Escape hatches as we grow:
1. A dedicated read replica for retrieval.
2. Partitioning `document_chunks` by `org_id` hash.
3. halfvec (16-bit) to halve storage.
4. Moving to Qdrant per tenant tier.

---

## R. Memory Architecture

| Concept | Definition | Lifetime | Where | P1 |
|---|---|---|---|---|
| Conversation context | messages in the current conversation sent to the LLM | per conversation | `messages` table, trimmed to a token window | ✓ |
| Memory (long-term) | facts learned about an end-user/contact or an agent ("prefers Hindi", "plan = Pro") | across conversations | `memories` table (+ pgvector), keyed by `(agent, end_user_ref)` | P2 |
| Knowledge | curated documents provided by the business | until changed | KBs/chunks | ✓ |
| Tool data | live data fetched at runtime from systems of record (CRM, etc.) | per call; never cached as memory by default | trace only | ✓ |

P1 window policy: keep the last N messages within a model-relative token budget (e.g., 30% of the context window). Tool results from older turns are compacted to a short summary. Optional rolling summarization is Should/P2. Conversations are keyed by `conversation_id`. The widget persists it in the visitor's localStorage. The API caller supplies or receives it. `end_user_ref` (an opaque external ID) is stored now to enable P2 long-term memory.

---

## S. Database Schema (Phase 1)

**Conventions**
- PostgreSQL 16 with `pgvector`. **UUIDv7 PKs** (time-ordered, index-friendly). The API exposes prefixed IDs (`agt_…`) as an encoding of the UUID.
- Every tenant-owned table has `org_id NOT NULL`. Workspace-scoped tables also have `workspace_id`. Composite indexes start with `org_id`/`workspace_id`.
- **RLS** on all tenant tables: `USING (org_id = current_setting('app.org_id')::uuid)`. The app sets it per transaction. Admin and worker use explicit roles.
- `created_at`, `updated_at`, `created_by` everywhere. **Soft delete** (`deleted_at`) on user-managed config: agents, tools, credentials, KBs, documents, workspaces, deployments. Telemetry is append-only and has no soft delete; it is removed by retention jobs and partition drops.
- Users and organizations may be **owned by the shared WorkEasy360 identity service**. In that case these tables are *local projections* keyed by the global IDs (see Q2).

**Tables (22). Deliberately excluded:** `agent_configs` (folded into versions), `models` table per tenant (platform catalog only), `integrations` (code definitions), `memories` (P2), `workflows` (P2).

| Table | Key columns | Notes |
|---|---|---|
| `organizations` | id, name, slug, plan, status(active/suspended), settings jsonb, external_ref | from shared identity |
| `users` | id, email, name, avatar_url, external_ref, last_login_at | projection |
| `workspaces` | id, org_id, name, slug, deleted_at | |
| `memberships` | id, org_id, workspace_id NULL, user_id, role | null workspace = org-level role; unique(org, workspace, user) |
| `api_keys` | id, org_id, workspace_id, name, prefix, key_hash(argon2/sha256+pepper), scopes[], last_used_at, expires_at, revoked_at | |
| `ai_models` | id, provider, model_key, display_name, capabilities jsonb, context_window, input_price_per_mtok, output_price_per_mtok, status, tier | platform-managed catalog |
| `agents` | id, org_id, workspace_id, name, description, avatar_url, status(active/disabled), **draft_config jsonb**, **published_version_id** FK, template_key, deleted_at | the draft lives here |
| `agent_versions` | id, org_id, agent_id, version_no, **config jsonb (immutable snapshot)**, config_hash, change_note, published_by, published_at | unique(agent_id, version_no) |
| `agent_version_tools` | agent_version_id, tool_id, requires_approval, description_override | integrity + "where used" |
| `agent_version_knowledge` | agent_version_id, knowledge_base_id | |
| `credentials` | id, org_id, workspace_id, integration_key, name, auth_type, **ciphertext bytea, iv, key_version**, metadata jsonb (non-secret), status, last4, expires_at, deleted_at | never selected by API layer except metadata |
| `tools` | id, org_id, workspace_id, provider_key, operation_key, name, description, input_schema jsonb, config jsonb, credential_id FK NULL, deleted_at | |
| `knowledge_bases` | id, org_id, workspace_id, name, embedding_model, chunking jsonb, deleted_at | |
| `documents` | id, org_id, kb_id, source_type(file/text/url), title, storage_key, source_url, mime, size_bytes, status, error, content_hash, token_count, deleted_at | dedupe by hash |
| `document_chunks` | id, org_id, kb_id, document_id, ordinal, content, metadata jsonb, **embedding vector(1536)**, **tsv tsvector** | HNSW(embedding vector_cosine_ops); GIN(tsv); btree(kb_id) |
| `deployments` | id, org_id, workspace_id, agent_id, channel(web_widget/api/internal), **version_policy (latest/pinned)**, pinned_version_id, public_key, config jsonb (allowed_origins, theme), status, deleted_at | |
| `conversations` | id, org_id, agent_id, deployment_id, channel, end_user_ref, title, status, last_message_at, metadata | |
| `messages` | id, org_id, conversation_id, role(user/assistant/tool/system), content jsonb (parts), execution_id, feedback smallint, created_at | index (conversation_id, created_at) |
| `executions` | id, org_id, workspace_id, agent_id, agent_version_id, deployment_id, conversation_id, kind(agent/test/workflow), source(playground/api/widget/internal), triggered_by_user_id/api_key_id, status, error_code, error_message, input_preview, output_preview, total_input_tokens, total_output_tokens, cost_usd numeric(12,6), latency_ms, step_count, started_at, completed_at | **monthly partitions** (from day one, cheap to set up) |
| `execution_steps` | id, org_id, execution_id, seq, type(llm/tool/retrieval/guardrail), name, status, input jsonb (redacted, size-capped), output jsonb, model_id, tokens_in, tokens_out, latency_ms, error, started_at | monthly partitions |
| `usage_records` | id, org_id, workspace_id, agent_id, execution_id, provider, model_key, kind(chat/embedding), input_tokens, output_tokens, cost_usd, occurred_at | source of truth for cost; rollup to `usage_daily` |
| `audit_logs` | id, org_id, actor_type/id, action, target_type/id, diff jsonb, ip, user_agent, created_at | append-only; shape compatible with a future shared WE360 audit service |

Plus small support tables: `usage_daily` (rollup), `plan_limits` (plan → limits jsonb), `feature_flags` (or use a flag service).

**Indexing highlights:**
- `agents(workspace_id, deleted_at)`
- `executions(org_id, agent_id, started_at desc)`
- `executions(org_id, status, started_at)`
- `document_chunks` HNSW `(m=16, ef_construction=64)` with `hnsw.iterative_scan` for filtered queries
- partial indexes `WHERE deleted_at IS NULL`

**Versioning in data:** The draft is stored in `agents.draft_config`. Publishing copies a validated snapshot into `agent_versions`. Deployments resolve `latest` → `agents.published_version_id`, or `pinned` → `pinned_version_id`. Executions always record `agent_version_id`.

---

## T. API Architecture

- **Style:** REST + JSON. SSE for streaming. Resource-oriented. **Versioned by path `/v1`**.
- **Contract:** OpenAPI 3.1 generated from Zod schemas (`packages/contracts`). A typed client is generated for the frontend and for other WE360 products.
- **Auth:**
  - User sessions: a JWT from WE360 identity (OIDC) in an `Authorization` header (an httpOnly cookie for the web app via the BFF).
  - **API keys** (`we360_sk_…`) for developers.
  - **Widget public keys** (`pk_…`) limited to `POST runs` on one deployment, plus origin check and per-visitor rate limit.
  - **Service tokens** (client-credentials + token exchange) for WE360 products.
- **Authorization:**
  - RBAC guard checks the role on org/workspace.
  - Resource guard checks ownership via the scoped repository. RLS backs it up.
  - Permissions use names like `agent:write`, `agent:publish`, `credential:manage`, `deployment:manage`, `logs:read`, `member:manage`.
- **Errors:** RFC 9457 `application/problem+json` with `{type, title, status, detail, code, request_id, errors[]}`.
- **Pagination:** cursor-based (`?limit=&cursor=`) returning `{data, next_cursor}`.
- **Idempotency:** `Idempotency-Key` header on POST runs and creates.
- **Rate limits:** Redis token bucket per API key, per org and per widget visitor. `429` with `Retry-After` and `RateLimit-*` headers.
- **Validation:** Zod at the edge. JSON Schema for tool inputs.

**Endpoints (P1):**
```
/v1/me, /v1/orgs/{org}/workspaces, /v1/workspaces/{ws}/members, /v1/workspaces/{ws}/api-keys
/v1/agents                         GET POST
/v1/agents/{id}                    GET PATCH(draft) DELETE
/v1/agents/{id}/duplicate          POST
/v1/agents/{id}/versions           GET POST(publish)
/v1/agents/{id}/versions/{v}       GET
/v1/agents/{id}/rollback           POST {version_id}
/v1/agents/{id}/test               POST (SSE; runs draft; full trace)
/v1/agents/{id}/runs               POST (published; stream|sync|async)
/v1/runs/{run_id}                  GET (status/result for async)
/v1/agents/{id}/deployments        GET POST ; /v1/deployments/{id} PATCH DELETE
/v1/agents/{id}/analytics          GET ?range=
/v1/executions  ?agent=&status=&from=   GET ; /v1/executions/{id} GET (with steps)
/v1/conversations ?agent=          GET ; /v1/conversations/{id}/messages GET
/v1/tools/catalog                  GET (providers/operations)
/v1/tools                          GET POST ; /v1/tools/{id} PATCH DELETE ; /v1/tools/{id}/test POST
/v1/credentials                    GET POST ; /v1/credentials/{id} PATCH DELETE ; /test POST
/v1/oauth/{integration}/start|callback  (Should)
/v1/knowledge-bases                GET POST ; /{id} PATCH DELETE ; /{id}/search POST (debug)
/v1/knowledge-bases/{id}/documents GET POST(multipart|url|text) ; /v1/documents/{id} GET DELETE ; /reindex POST
/v1/models                         GET (catalog)
/v1/usage ?range=                  GET
/v1/audit-logs                     GET
/public/v1/widget/{pk}/config|runs  (widget surface, CORS restricted)
/internal/admin/*                  (admin app only; separate auth audience)
```

---

## U. Frontend Architecture

- **Next.js (App Router) + React + TypeScript**, used as UI and a thin BFF (session cookie ↔ bearer token). **No business logic in route handlers**, so other products use the same API.
- **UI:** Tailwind CSS + shadcn/ui (Radix) in `packages/ui`, to become the shared WE360 design system. Lucide icons.
- **Server state:** TanStack Query, using the generated API client. **Local/editor state:** Zustand (builder draft, canvas later). **Forms:** React Hook Form + Zod (schemas shared from `packages/contracts`).
- **Streaming chat:** an SSE client hook (or AI SDK UI's `useChat` with a custom transport). The trace panel renders runtime events.
- **Builder UX:** autosaving draft (debounced PATCH, optimistic concurrency via `draft_revision`), "unpublished changes" banner, publish dialog with change note.
- **Visual canvas (P2):** **React Flow (@xyflow/react)**. It is the de-facto choice (used by Dify, Langflow, Flowise and others), MIT, with good performance. The node registry is shared with the backend node definitions.
- **Widget:** a separate tiny bundle (`apps/widget`, Preact or vanilla TS, <50 KB gz) rendered in an iframe with a loader script. Theming via deployment config. Mirrors the ChatKit pattern.
- **Embeddable SDK for WE360 products:** `@we360/agent-chat` React component.
- **Admin:** *(superseded by §0.6)* the `/admin` route group in `apps/web`, with its own API prefix, role guard, 2FA and optional IP allowlist.
- Charts with Recharts. Tables with TanStack Table. i18n-ready (next-intl) from the start, given the likely India/multilingual market.

---

## V. Backend Architecture

**Comparison:**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Node.js/TS only** | One language and type system end to end; shared Zod contracts; AI SDK is excellent; all LLM work is I/O-bound HTTP calls; simplest ops | Weaker for advanced document parsing/OCR and ML | **Phase 1** |
| Node API + Python AI service | Python AI ecosystem (LangGraph, Docling, sentence-transformers) | Two stacks, a network hop in the hot path, duplicated contracts and auth, harder debugging | Not now |
| Python only (FastAPI) | AI ecosystem | Splits from Next.js frontend and other WE360 products (likely TS) | No |

**Decision:** Node.js/TS **modular monolith**.
- **API:** Node.js + Express 5 (confirmed by the product owner). Modules are folders with routes and services. RBAC and tenancy are middleware (`requireSession`, `requireTenant`, `requireRole`, `requirePlatformRole`). SSE streaming works with plain `res.write`.
- **Worker:** the same codebase as a separate entrypoint (`apps/worker`) running BullMQ processors.
- **Python** is introduced later only as an **isolated job-type worker** (e.g., `ingest.parse.advanced` for OCR/Docling, or self-hosted embeddings/rerankers) behind a queue. It never sits in the request path.

**Modules (bounded contexts inside the monolith; they communicate via service interfaces, never via each other's tables):**
`identity` (projection + guards) · `tenancy` · `agents` (+versions) · `models` (gateway, catalog) · `runtime` (adapter around `packages/agent-runtime`) · `tools` (registry, executor) · `connections` (credentials, OAuth) · `knowledge` (KBs, ingestion, retrieval) · `conversations` · `deployments` (channels) · `observability` (executions, steps) · `usage` (metering, quotas) · `audit` · `admin`.

**ORM:** Drizzle ORM: SQL-first, typed, supports pgvector, RLS-friendly, light. Migrations via drizzle-kit, reviewed SQL. Prisma is the alternative (weaker for pgvector/RLS/partitioning).

**ModelGateway:** wraps Vercel AI SDK providers (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, OpenAI-compatible for open models).
- Adds: catalog resolution, per-tenant key selection (platform key now, BYOK later), retries/fallback, token and cost accounting, timeouts, and an option to route through a gateway (LiteLLM/Portkey/Cloudflare AI Gateway) later.
- The runtime depends on `ModelGateway`, **never** on the AI SDK directly. This hedges against SDK churn.

---

## W. Infrastructure Architecture

**Phase 1 (AWS, region decided by market: likely `ap-south-1` Mumbai for India; see Q6):**

| Concern | Choice | Why |
|---|---|---|
| Containers | Docker; **ECS Fargate** services: `web` (Next.js), `api`, `worker`; `admin` | No cluster ops; scales per service. EKS/K8s not justified yet |
| DB | **RDS PostgreSQL 16** (Multi-AZ in prod) + pgvector; RDS Proxy later | Managed, PITR backups |
| Cache/queue | **ElastiCache Redis (Valkey)** | BullMQ, rate limits, quota counters, SSE fan-out later |
| Files | **S3** (KMS-encrypted, private) + pre-signed uploads | |
| CDN/edge | **CloudFront** + AWS WAF in front of ALB; widget assets on S3+CloudFront | |
| Secrets/keys | Secrets Manager (platform secrets), **KMS** (envelope keys) | |
| Email | SES | Send Email tool, notifications |
| Observability | OpenTelemetry → CloudWatch / Grafana Cloud; Sentry for errors; optional **Langfuse** (self-host) for LLM traces | |
| CI/CD | GitHub Actions → ECR → ECS (blue/green via CodeDeploy) | |
| IaC | Terraform (or AWS CDK in TS) | Shared WE360 infrastructure modules |
| Envs | dev, staging, prod (separate AWS accounts via Organizations) | |

**Vercel?** It is fine for the marketing site or a quick prototype. For the product, keep web, API and data in **one AWS VPC/region** for latency, data residency, private networking to RDS and a single security boundary. Revisit if the frontend team strongly prefers Vercel (web only, with the API on AWS).

**Evolution path:**
1. **MVP:** 1–2 tasks per service, single RDS.
2. **Growth:** autoscale workers on queue depth; separate `runtime-worker` pool for interactive runs; RDS read replica for analytics and retrieval; partitions; usage rollups.
3. **Scale (millions of runs/day):**
   - extract `agent-runtime` and `ingestion` into independently scaled services (already packages)
   - move logs/traces to a columnar store (ClickHouse) with only summaries in Postgres
   - event bus (EventBridge/SNS+SQS) for cross-product events
   - move large tenants' vectors to Qdrant
   - multi-region
4. **Enterprise:** dedicated-tenant deployments (cell-based architecture).

---

## X. Security Architecture

| Threat / need | P1 control |
|---|---|
| Authentication | WE360 OIDC (email/password + Google OAuth via identity provider); MFA available via IdP; SSO in P2 |
| Authorization | RBAC: Owner, Admin, Builder, Viewer (org + workspace scope); resource ownership checks; API key scopes |
| Tenant isolation | `org_id` on every row; scoped repositories; **Postgres RLS**; S3 prefixes per org; cache keys prefixed; tests that try cross-tenant access |
| Secrets | KMS envelope encryption; never returned or logged; decrypted per call; rotation support |
| API keys | Shown once, hashed at rest, prefixed for leak scanning (GitHub secret scanning partner later), expiry/revoke |
| **Prompt injection** | Treat retrieved docs and tool outputs as **untrusted data**: wrap them in delimited blocks with a "do not follow instructions in data" system preamble. Tools are restricted to those bound to the version. **Write tools** (`sideEffect: write`) default to "confirm" behavior for public channels. Tool args are validated by schema. No credential is ever in model context |
| Tool abuse | Per-run step limits; per-tool rate limits; allowlist of tools per version; approval flag; egress logging |
| **SSRF** (HTTP tool, URL ingestion) | Resolve DNS, then block private/link-local/metadata ranges (169.254.169.254, 10/8, 172.16/12, 192.168/16, ::1, fc00::/7). Re-check after redirects (max 3). Ports 80/443 only. Response size cap and timeout. Runs through an egress proxy in a separate subnet with no access to internal services |
| Data leakage | Agents only retrieve from KBs bound to the version; retrieval enforces `org_id`; logs store redacted, size-capped payloads; providers under **zero-data-retention / no-training** terms |
| Widget abuse | Origin allowlist, public key scoped to one deployment, per-visitor and per-IP rate limit, optional Turnstile/hCaptcha, per-deployment daily cost cap |
| Rate limiting & DoS | WAF; Redis token buckets; org quota hard stops |
| Audit | Audit log for all config, credential, member, deployment and publish actions; admin actions included |
| Encryption | TLS 1.2+; RDS/S3/Redis encryption at rest |
| Compliance prep | India DPDP Act / GDPR: data export and delete per org; retention settings; DPA with LLM providers |

---

## Y. Multi-Tenant Architecture

- **Model:** shared database, shared schema, `org_id` discriminator, plus RLS. This is the standard for SaaS at this stage: cheapest, simplest migrations, works with pgvector.
- **Hierarchy:**
  - `Organization` (billing, identity and plan boundary; maps to the WE360 customer account)
  - → `Workspace` (team/client boundary; agencies use one per client)
  - → resources: agents, KBs, tools, credentials, deployments
  - → telemetry: executions, conversations, usage. Telemetry carries both `org_id` and `workspace_id`.
- **Request flow:** auth middleware resolves `user`/`api_key` → `TenantContext{orgId, workspaceId, role}` → stored in AsyncLocalStorage → repositories auto-filter → DB transaction runs `SET LOCAL app.org_id`.
- **Noisy neighbor:** per-org queue concurrency limits (BullMQ groups or per-org rate limiters), per-org quotas.
- **Upgrade path:** enterprise "silo" tenants (dedicated DB or schema) via a tenant → connection routing table. No code change, because everything already goes through TenantContext.

---

## Z. WorkEasy360 Integration Architecture

Principles: **contracts, not databases.** The agent platform never reads another product's DB.

1. **Shared identity:** a single WE360 IdP (OIDC). Orgs and users are global. Each product keeps projections. *(Confirm whether one exists; Q2.)*
2. **Internal Tool Contract:** each WE360 product publishes a **Tool Manifest**:
   - an OpenAPI subset annotated with `x-agent-tool` (name, description, sideEffect, required scopes), served at `/.well-known/we360-agent-tools.json`
   - later an MCP server
   - the platform imports it into the **Internal Tool Registry** as a `we360.<product>` provider
3. **Delegated auth:** when an agent calls a WE360 product tool, the platform performs **token exchange** (RFC 8693) for a short-lived token on behalf of the *end user or the agent's service principal*, limited to the declared scopes. The product enforces its own permissions, so agents can never do more than the acting identity can.
4. **Embedding:**
   - products embed agents via `@we360/agent-chat` and the public API (service token)
   - "AI features" inside products (summarize, draft) call `/v1/agents/{id}/runs`, or a lightweight `/v1/ai/complete` utility endpoint (Should; avoids every product integrating LLMs separately)
5. **Events (P2):** products emit domain events (e.g., `crm.lead.created`) to a shared bus (EventBridge). Workflows/agents subscribe as triggers. Phase 1: a webhook trigger is enough.
6. **Shared packages:** `ui`, `auth-client`, `contracts`, `observability`, `config` reused across products. Shared **billing/usage**: the platform emits usage records in a format the future WE360 billing service can consume.
7. **First integrations:** pick one product tool pack for P1 (CRM is most valuable for support/sales agents; SailoAI CRM is a candidate).

---

## AA. Repository Structure

> **Superseded by §0.8:** each WE360 product has its own repo, so this is a standalone repo, and the admin lives inside `apps/web`. The tree below is the long-term shape.

**Recommendation:** **pnpm + Turborepo monorepo**. Start it as the WE360 platform monorepo if the other six products are not already in one. Otherwise create it as the agent platform repo with `packages/*` designed to be published as internal npm packages. *(Q3)*

```
workeasy360-ai/                    (or apps inside existing WE360 monorepo)
├── apps/
│   ├── web/                Next.js product UI (agent studio)
│   ├── api/                Express 5 HTTP API
│   ├── worker/             BullMQ processors (ingestion, async runs, rollups)
│   ├── admin/              Next.js internal admin
│   └── widget/             embeddable chat widget bundle
├── packages/
│   ├── agent-runtime/      pure runtime loop (ports/adapters), no IO deps
│   ├── ai-gateway/         ModelGateway, provider adapters, pricing
│   ├── tools/              registry, executor, SSRF guard, built-in providers
│   │   └── providers/{http,email,knowledge,we360-crm}/
│   ├── knowledge/          parsers, chunker, embedder, VectorIndex(pgvector)
│   ├── db/                 Drizzle schema, migrations, RLS helpers, repositories base
│   ├── contracts/          Zod schemas → OpenAPI, generated TS client
│   ├── auth/               token verification, TenantContext, RBAC permissions
│   ├── ui/                 shadcn-based design system (shared WE360)
│   ├── chat-sdk/           @we360/agent-chat React component
│   ├── observability/      logger (pino), OTel setup, tracer
│   └── config/             eslint, tsconfig, tailwind presets
├── infra/terraform/        envs/{dev,staging,prod}, modules
├── docs/architecture/      this document, ADRs (docs/adr/0001-*.md)
└── docker-compose.yml      postgres+pgvector, redis, minio, mailpit for local dev
```
There is no `services/` folder yet. Extract `agent-runtime` and `ingestion` into deployable services only when the scaling triggers in §W occur.

---

## AB. Mermaid Architecture Diagrams

### 1. System Architecture
```mermaid
flowchart LR
  subgraph Clients
    U[Builder UI - Next.js]:::c
    W[Web Widget]:::c
    D[Developer API Client]:::c
    P[WE360 Products]:::c
  end
  subgraph AWS VPC
    CF[CloudFront + WAF] --> ALB
    ALB --> WEB[web: Next.js]
    ALB --> API[api: Express]
    API --> RT[[agent-runtime pkg]]
    API -- jobs --> R[(Redis / BullMQ)]
    R --> WK[worker]
    WK --> RT
    RT --> GW[ModelGateway]
    RT --> TX[Tool Executor]
    RT --> RET[Retriever]
    API --> PG[(PostgreSQL + pgvector)]
    WK --> PG
    RET --> PG
    WK --> S3[(S3)]
    TX --> EGR[Egress proxy / SSRF guard]
    API --> KMS[KMS]
  end
  GW --> LLM[(OpenAI / Anthropic / Gemini / ...)]
  EGR --> EXT[(External APIs)]
  TX --> WEAPI[(WE360 Product APIs)]
  IDP[WE360 Identity - OIDC] -.tokens.-> API
  U --> CF; W --> CF; D --> CF; P --> CF
```

### 2. Agent Runtime Architecture
```mermaid
flowchart TB
  IN[Run request + TenantContext] --> RES[Resolve deployment → agent version snapshot]
  RES --> PRE[Pre-flight: quota, rate limit, input guardrails]
  PRE --> CTX[Context builder: system prompt + variables + memory window + optional always-retrieval]
  CTX --> LLM[ModelGateway.stream with tool schemas]
  LLM -->|tool calls| VAL[Validate args / binding / approval flag]
  VAL --> EXE[Execute tools in parallel w/ timeout]
  EXE --> OBS[Truncate + wrap results as untrusted data]
  OBS --> LIM{Limits ok? steps/tokens/time}
  LIM -->|yes| LLM
  LIM -->|no| STOP[Graceful stop + fallback msg]
  LLM -->|final text| OUT[Stream response]
  OUT --> PERSIST[Persist messages, steps, usage, cost]
  STOP --> PERSIST
```

### 3. Agent Creation Flow
```mermaid
flowchart LR
  A[New agent] --> B{Template / Describe / Blank}
  B --> C[Identity] --> D[Instructions] --> E[Model]
  E --> F[Knowledge] --> G[Tools + Connections] --> H[Memory & Limits]
  H --> T[Playground test - draft]
  T -->|iterate| D
  T --> PUB[Publish vN]
  PUB --> DEP[Deploy: Widget / API / Embedded]
  DEP --> MON[Monitor] --> IMP[Edit draft] --> T
```

### 4. Agent Execution Flow (sequence)
```mermaid
sequenceDiagram
  participant C as Channel (widget/API)
  participant A as API
  participant RT as Runtime
  participant M as ModelGateway
  participant T as ToolExecutor
  participant DB as Postgres
  C->>A: POST /runs (pk/api key, conversation_id, input)
  A->>A: auth, origin check, rate limit, quota
  A->>DB: create execution(status=running), load version + history
  A->>RT: runAgent(snapshot, input, ports)
  RT->>M: stream(messages, tools)
  M-->>RT: tool_call(crm.lookup, args)
  RT->>T: execute(args)
  T-->>RT: result (truncated)
  RT->>M: stream(+tool result)
  M-->>RT: text deltas
  RT-->>A: events
  A-->>C: SSE text.delta ... run.completed
  A->>DB: messages, steps, usage_records, execution(succeeded)
```

### 5. Knowledge / RAG Flow
```mermaid
flowchart LR
  UP[Upload / URL / Text] --> S3[(S3)] --> Q[[ingest job]]
  Q --> PARSE[Parse → Markdown] --> CH[Structure-aware chunking]
  CH --> EMB[Embed batch via ModelGateway] --> PGV[(document_chunks: vector + tsvector)]
  QRY[Query from runtime] --> QE[Embed query]
  QE --> VS[pgvector HNSW top-k]
  QRY --> FTS[Postgres FTS top-k]
  VS --> RRF[Reciprocal Rank Fusion + filters org/kb]
  FTS --> RRF
  RRF --> CTXT[Context chunks + citations] --> LLM[LLM]
```

### 6. Tool Execution Flow
```mermaid
flowchart TB
  CALL[Model tool_call name+args] --> LOOK[Lookup binding in version snapshot]
  LOOK -->|not bound| REJ[Error to model]
  LOOK --> SCH[Validate input JSON Schema]
  SCH --> APR{requires approval?}
  APR -->|P1: yes| NEED[Return 'approval required' to model / P2: pause run]
  APR -->|no| CRED[Decrypt credential via KMS data key]
  CRED --> PROV[Provider handler from ToolRegistry]
  PROV --> EG[Egress guard: DNS/IP checks, timeout, size cap]
  EG --> EXT[(External / WE360 API)]
  EXT --> RES[Normalize + truncate + redact]
  RES --> TRACE[execution_step] --> BACK[Return to model]
```

### 7. Authentication / Authorization
```mermaid
sequenceDiagram
  participant B as Browser
  participant W as Next.js BFF
  participant I as WE360 IdP (OIDC)
  participant A as API
  B->>W: login
  W->>I: OIDC auth code + PKCE
  I-->>W: id/access token (sub, org claims)
  W-->>B: httpOnly session cookie
  B->>W: action
  W->>A: Bearer access token
  A->>A: verify JWT (JWKS) → TenantContext(org, ws, role)
  A->>A: RBAC guard (permission) + scoped repo + SET LOCAL app.org_id (RLS)
```

### 8. Multi-Tenant Architecture
```mermaid
flowchart TB
  ORG[Organization - plan, billing, identity] --> WS1[Workspace A]
  ORG --> WS2[Workspace B]
  ORG --> MEM[Memberships & roles]
  WS1 --> AG[Agents] --> V[Versions]
  WS1 --> KB[Knowledge bases] --> DOC[Documents] --> CHK[Chunks]
  WS1 --> TL[Tools] --> CR[Credentials - encrypted per org key]
  WS1 --> DP[Deployments]
  AG --> EX[Executions / Conversations / Usage - org_id + ws_id]
  subgraph Enforcement
    TC[TenantContext ALS] --> REPO[Scoped repositories] --> RLS[Postgres RLS]
  end
```

### 9. WorkEasy360 Integration
```mermaid
flowchart LR
  subgraph WE360 Products
    PA[CRM / SailoAI] --- MA[Tool Manifest]
    PB[Product B] --- MB[Tool Manifest]
    PC[Product C] --- MC[Tool Manifest]
  end
  MA --> REG[Internal Tool Registry]
  MB --> REG
  MC --> REG
  REG --> PLAT[AI Agent Platform]
  PLAT --> AGT[Agents]
  AGT -- token exchange, scoped --> PA
  PA -- embed @we360/agent-chat / API --> PLAT
  IDP[Shared Identity] -.-> PLAT & PA & PB & PC
  BUS[(Event bus - P2)] -.events.-> PLAT
  PLAT -. usage records .-> BILL[Shared Billing - future]
```

### 10. Deployment Architecture
```mermaid
flowchart TB
  GH[GitHub Actions] --> ECR[ECR images] --> ECS
  subgraph Region ap-south-1 (TBC)
    WAF[WAF] --> CFD[CloudFront] --> ALB[ALB - public subnets]
    subgraph ECS[ECS Fargate - private subnets]
      WEB[web] ; API[api] ; WRK[worker] ; ADM[admin - internal ALB]
    end
    ALB --> WEB & API
    API & WRK --> RDS[(RDS Postgres Multi-AZ)]
    API & WRK --> REDIS[(ElastiCache)]
    WRK --> S3[(S3)]
    WRK & API --> NAT[Egress proxy / NAT] --> NET((Internet: LLMs, APIs))
    API --> KMS[KMS] ; API --> SM[Secrets Manager]
  end
  CFD --> S3W[(S3 widget assets)]
```

### 11. Database ER Diagram
```mermaid
erDiagram
  organizations ||--o{ workspaces : has
  organizations ||--o{ memberships : has
  users ||--o{ memberships : has
  workspaces ||--o{ api_keys : has
  workspaces ||--o{ agents : has
  agents ||--o{ agent_versions : versions
  agents |o--o| agent_versions : published_version
  agent_versions ||--o{ agent_version_tools : binds
  agent_versions ||--o{ agent_version_knowledge : binds
  tools ||--o{ agent_version_tools : used_by
  knowledge_bases ||--o{ agent_version_knowledge : used_by
  credentials |o--o{ tools : authenticates
  workspaces ||--o{ knowledge_bases : has
  knowledge_bases ||--o{ documents : has
  documents ||--o{ document_chunks : has
  agents ||--o{ deployments : exposed_by
  deployments ||--o{ conversations : hosts
  conversations ||--o{ messages : has
  agents ||--o{ executions : runs
  agent_versions ||--o{ executions : executed_as
  executions ||--o{ execution_steps : has
  executions ||--o{ usage_records : meters
  ai_models ||--o{ usage_records : priced_by
  organizations ||--o{ audit_logs : records
```

---

## AC. Feature Dependency Graph

```mermaid
flowchart TB
  F0[Repo, CI, infra skeleton, local dev] --> F1[Identity integration + TenantContext + RBAC]
  F1 --> F2[Org/Workspace/Members/API keys]
  F2 --> F3[Agent CRUD + draft config]
  F3 --> F4[Versioning: publish/rollback]
  F0 --> F5[ModelGateway + model catalog + pricing]
  F3 & F5 --> F6[Runtime core loop no tools + streaming]
  F6 --> F7[Conversations/memory window]
  F6 --> F8[Execution traces + usage records]
  F8 --> F9[Playground UI with trace panel]
  F2 --> F10[Credentials + KMS]
  F6 & F10 --> F11[Tool framework + HTTP/Email tools + SSRF guard]
  F11 --> F12[WE360 tool contract + first product tool pack]
  F0 --> F13[Queue/worker]
  F13 & F5 --> F14[Knowledge ingestion + pgvector]
  F14 & F11 --> F15[Knowledge search tool / always-retrieval]
  F4 & F7 & F9 --> F16[Deployments: API keys runs, widget, embed SDK]
  F8 --> F17[Quotas/rate limits]
  F8 --> F18[Analytics + logs UI]
  F8 & F2 --> F19[Admin panel]
  F16 & F17 --> F20[Security hardening + load tests + launch]
```
Key ordering insight: **traces and the playground come before tools and knowledge.** Every later feature is developed and debugged through them.

---

## AD. Phase 1 Development Roadmap (sequence)

M0 Decisions & Foundation → M1 Identity & Tenancy → M2 Agent Management & Versioning → M3 Model Gateway & Runtime Core → M4 Playground, Conversations & Traces → M5 Credentials & Tools → M6 Knowledge/RAG → M7 Deployments (API, Widget, Embed) → M8 Usage, Quotas & Analytics → M9 Admin, Audit & Templates → M10 Hardening & Launch. Details are in §AH.

---

## AE. Risks and Trade-offs

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | **Scope creep toward canvas/multi-agent** | Delays MVP | Strict P1 list; ADRs; canvas is P2 |
| 2 | **Prompt injection → harmful tool actions** | Data loss, reputational damage | Untrusted-data wrapping, bound-tool allowlist, write-tool confirmation on public channels, schema validation, limits |
| 3 | **LLM cost blowouts** (loops, abusive widget traffic) | Margin loss | Step/token caps, per-deployment cost caps, quotas, rate limits, captcha, alerts |
| 4 | **Cross-tenant data leakage** | Existential | RLS + scoped repos + automated isolation tests + security review |
| 5 | **RAG quality disappoints** | Churn | Hybrid search, citations, chunk preview, feedback loop; reranker P2; evals P2 |
| 6 | **Identity decision for whole ecosystem** | Rework across 7 products | Decide in M0 (Q2); code against OIDC interface |
| 7 | **Provider/SDK churn** (e.g., OpenAI Agent Builder shutdown) | Rewrites | Own `ModelGateway`/runtime; use only plain model APIs |
| 8 | **pgvector limits at scale** | Latency | `VectorIndex` abstraction, partitioning, replica, Qdrant escape hatch |
| 9 | **Log volume in Postgres** | Cost, bloat | Partitions, payload caps, retention, ClickHouse later |
| 10 | **Sync streaming in API process** | API saturation | Limits; extract runtime workers when triggers hit |
| 11 | Non-determinism makes support hard | Support load | Version pinning per execution, full traces, replay-from-trace (P2) |

Trade-offs accepted: a monolith over services (speed vs independent scaling); pgvector over a specialized DB (simplicity vs peak performance); config builder over canvas (accessibility vs flexibility); Node-only over Python (one stack vs ML ecosystem).

---

## AF. Open Questions

> **Resolved in v0.2.** Answers are in §0.1, and the remaining questions are in §0.10. The original questions are kept below for the record.

1. **SailoAI relationship:** Is SailoAI one of the six WE360 products? Should its AI Brain/agents migrate onto this platform, and is its CRM the first tool pack? Can its WhatsApp WABA integration become our P2 channel?
2. **Identity:** Does WE360 already have a shared auth/IdP (which one: Cognito, Keycloak, Auth0, Clerk, custom)? If not, should this project establish it (recommendation: an OIDC IdP such as Keycloak/Zitadel self-hosted, or Cognito/WorkOS managed)?
3. **Repo strategy:** Are the existing six products in a monorepo, and what stack (Next.js/Node?)? Join it, or create a new repo with publishable shared packages?
4. **Existing infra:** Are you already on AWS (accounts, region, Terraform)? Shared RDS cluster or a dedicated one per product?
5. **LLM keys:** Platform-paid keys only in P1 (recommended), or BYOK from day one? Which providers do you have contracts with?
6. **Market and residency:** Primarily India (₹ pricing suggests yes) → `ap-south-1`, DPDP Act, Hindi/regional languages, WhatsApp-first in P2?
7. **Team and timeline:** Team size and target launch date (affects M-sizing).
8. **Primary P1 channel:** Web widget, or embedded inside WE360 products first?
9. **Plans:** Should P1 enforce plan limits (Free/Starter/…) or just org quotas set by admin?

---

## AG. Recommended Technology Stack

| Layer | Choice | Reasoning |
|---|---|---|
| Language | **TypeScript** everywhere | One type system; shared contracts; hiring |
| Frontend | **Next.js (App Router), React, Tailwind, shadcn/ui, TanStack Query, Zustand, RHF+Zod** | Ecosystem standard; shared WE360 UI kit |
| Canvas (P2) | **React Flow (@xyflow/react)** | Proven by Dify/Langflow/Flowise; MIT |
| API | **Node.js + Express 5** | Confirmed choice; widely known, minimal, middleware-based tenancy/RBAC, async error handling built in |
| Validation/contracts | **Zod → OpenAPI 3.1** (zod-openapi), generated client | Single source of truth |
| AI | **Vercel AI SDK 6** behind own **ModelGateway**; OpenAI + Anthropic (+ Gemini) | Provider abstraction, tool calling, streaming, MCP client ready |
| Runtime | Own `agent-runtime` package (bounded tool loop) | Control over limits, tracing, tenancy; not LangChain/LangGraph (heavy, churn) |
| DB / ORM | **PostgreSQL 16 + pgvector**, **Drizzle** | One datastore, RLS, vectors, FTS |
| Queue/cache | **Redis (ElastiCache/Valkey) + BullMQ** | Ingestion, async runs, rate limits; simple |
| Storage | **S3** (MinIO locally) | |
| Email | SES (Mailpit locally) | |
| Observability | pino, **OpenTelemetry**, Sentry, Langfuse (optional) | Traces across API→runtime→tools |
| Infra | **AWS: ECS Fargate, RDS, ElastiCache, S3, CloudFront, WAF, KMS, Secrets Manager**; Terraform; GitHub Actions | Managed, no K8s |
| Testing | Vitest, Testcontainers (Postgres/Redis), Playwright, k6 load tests, LLM mocks + recorded fixtures | |

---

## AH. Development Milestones (Phase 1)

> **For the launch, use the 6-week plan in §0.7.** These milestones remain the full Phase 1 reference. Anything below that is not in §0.2 becomes v1.1+ work.

Each milestone ends with a demo and a Definition of Done (DoD). Week estimates assume about 5 engineers.

**M0. Decisions & Foundation (1.5 wk)**
- Objective: resolve §AF; repo; CI; local env; infra skeleton.
- Features: monorepo, lint/format, ADRs, docker-compose (pg+pgvector, redis, minio, mailpit), Terraform dev env, CI (typecheck, test, build), base Express app with health, base Next.js shell, logging/OTel.
- DB: migration tooling, extensions (`vector`, `pg_trgm`).
- Tests: CI green; smoke test.
- DoD: `pnpm dev` runs the full stack locally; deploys to dev on merge.

**M1. Identity & Tenancy (2 wk)**
- Deps: M0, Q2.
- DB: organizations, users, workspaces, memberships, api_keys, audit_logs; RLS policies.
- API: /me, workspaces, members, api-keys.
- Backend: JWT verification (JWKS), TenantContext (ALS), RBAC guards, scoped repository base, audit interceptor.
- Frontend: login via IdP, org/workspace switcher, members page, API keys page.
- Tests: **cross-tenant isolation suite** (must fail to read others' data at the repo and RLS levels).
- DoD: two orgs fully isolated; roles enforced; audit entries written.

**M2. Agent Management & Versioning (2 wk)**
- Deps: M1.
- DB: agents, agent_versions, ai_models (seed).
- API: agents CRUD, duplicate, versions publish/list/rollback.
- Frontend: agent list (dashboard), Build tabs (Identity, Instructions, Model), autosave draft, publish dialog, versions page.
- Backend: config schema (Zod, versioned `schema_version`), publish validation, snapshot hashing.
- Tests: version immutability, rollback, concurrency on draft.
- DoD: a user can create, edit, publish, roll back and duplicate agents.

**M3. Model Gateway & Runtime Core (2 wk)**
- Deps: M2.
- DB: executions, execution_steps (partitioned), usage_records.
- Backend: ModelGateway (OpenAI + Anthropic), pricing, retries/fallback; `agent-runtime` loop with limits (tool slot present but empty); SSE endpoint `/agents/{id}/test`; tracer writing steps and usage.
- Infra: provider secrets in Secrets Manager.
- Tests: runtime unit tests with mocked model (deterministic fixtures), limit enforcement, provider error handling.
- DoD: streaming answer from draft config, with tokens, cost and latency recorded.

**M4. Playground, Conversations & Traces (1.5 wk)**
- Deps: M3.
- DB: conversations, messages.
- Backend: memory window.
- Frontend: playground pane (chat, reset, draft/published toggle), trace panel (steps, tokens, latency, errors), executions list and detail page.
- Tests: Playwright playground E2E.
- DoD: multi-turn chat with visible traces; execution log browsable.

**M5. Credentials & Tools (2.5 wk)**
- Deps: M3, M1.
- DB: credentials, tools, agent_version_tools.
- Backend: KMS envelope encryption; ToolRegistry; ToolExecutor (Ajv, timeouts, truncation); providers: http_request (SSRF guard + egress proxy), send_email (SES); WE360 tool-manifest importer and the first product tool pack (per Q1); test-connection and test-tool endpoints.
- Frontend: Tools & Connections pages; custom HTTP tool builder (method, URL, headers, params → generated JSON Schema); Tools tab on agent; tool calls in the trace.
- Infra: KMS key, egress proxy subnet.
- Tests: SSRF test suite (private IPs, DNS rebinding, redirects), secret never-in-response tests, tool error recovery.
- DoD: an agent calls a real external API and the WE360 product tool safely, with full trace.

**M6. Knowledge / RAG (2.5 wk)**
- Deps: M0 queue, M3 gateway, M5 (knowledge tool).
- DB: knowledge_bases, documents, document_chunks (HNSW, GIN), agent_version_knowledge.
- Backend: worker ingestion pipeline (parse → chunk → embed → upsert), status updates, URL fetch via SSRF guard, hybrid retrieval with RRF, knowledge_search tool, "always" mode, citations.
- Frontend: KB pages, upload with progress and status, chunk preview, debug search, Knowledge tab, retrieved chunks in trace, citations in chat.
- Infra: S3 bucket, worker autoscaling.
- Tests: ingestion fixtures per format; retrieval quality smoke set (about 30 Q/A pairs); deletion removes chunks.
- DoD: upload docs, ask questions, get cited answers.

**M7. Deployments: API, Widget, Embed (2 wk)**
- Deps: M4, M5, M6.
- DB: deployments.
- API: `/agents/{id}/runs` (sync/stream/async + `/runs/{id}`), idempotency, public widget endpoints, CORS/origin checks.
- Backend: version policy resolution (latest/pinned), async runs via worker, callback webhook (signed).
- Frontend: Deploy tab (widget snippet, theme, allowed domains, API docs/snippets, pin version); `apps/widget`; `@we360/agent-chat` package.
- Infra: widget CDN.
- Tests: widget E2E on a test site, API contract tests, origin rejection.
- DoD: agent live on an external site and callable via API key; embedded in one WE360 product (or a stub app).

**M8. Usage, Quotas & Analytics (1.5 wk)**
- Deps: M3, M7.
- DB: usage_daily rollups, plan_limits.
- Backend: Redis counters for quota and rate limits (org, API key, deployment, visitor), hard-stop errors, spend alerts (Could), daily rollup job.
- Frontend: Usage page; agent Monitor overview (executions, success rate, p50/p95, tokens, cost, top tools); conversation inbox (Should); feedback 👍/👎.
- Tests: quota exhaustion behavior, rollup correctness.
- DoD: an org cannot exceed its quota; dashboards match raw records.

**M9. Admin, Audit & Templates (1.5 wk)**
- Deps: M1, M8.
- Admin app: orgs/users, usage and cost by org/agent, suspend/unsuspend, model catalog editing (prices, enable/disable), feature flags, recent failed executions.
- Product: audit log UI; 5–8 templates; "Describe your agent" generator (Should).
- Tests: admin authz (internal audience only).
- DoD: ops can operate the platform without DB access.

**M10. Security Hardening & Launch Readiness (2 wk)**
- Deps: all.
- Work: threat model review, prompt-injection red-team set, dependency and container scanning, WAF rules, pen test (external if possible), k6 load test (target, e.g., 100 concurrent streaming runs, p95 first-token < 2.5 s excluding model latency overhead), backup/restore drill, retention jobs, runbooks, alerting (error rate, queue depth, provider failures, cost anomalies), staging→prod Terraform, DPA/ZDR with providers, privacy policy/terms update.
- DoD: prod environment live; on-call runbook; launch checklist signed off.

**Total:** about 19–21 weeks. Parallelism opportunities: frontend work trails backend by about one milestone; M6 can start in parallel with M5 after M3.

---

## Next Steps (after this document is approved)

*(Updated in v0.2.)*

1. **Build first (W1):** repo + CI, AWS staging in `ap-south-1`, schema v1 with RLS, Better Auth (email, Google, orgs, invites), app shell, ModelGateway spike. Request SES production access.
2. **Build second (W2):** agents with draft/publish, runtime + playground with traces, BYOK, super admin skeleton.
3. **Postponed to v1.1:** payments, conversation inbox, analytics charts, email tool, URL import, OAuth connections, multi-workspace UI, async runs, AI-assisted setup. Phase 2 items are unchanged.
4. **Still to confirm:** §0.10 (plan numbers and prices, manual paid plans at launch, provider accounts and caps, domain and branding, beta vs GA, Terraform).
5. **Locked:** the stack and design choices confirmed in §0.1.

### Verification of this document
- Every one of the 25 design questions (§35 of the brief) is answered in the sections above: Agent (§L), Agent vs Workflow (§N), Tool vs Integration (§O/§P), registration (§O), credentials (§P), knowledge access (§Q), memory (§R), isolation (§X/§Y), sync/async (§N), Redis/queue (§N), Python (§V), pgvector (§Q), tenancy (§Y), versions and updates (§S, J1), logs (§S), costs (§S/M8), WE360 tools (§Z), third-party integrations (§P), scale (§W), risks (§AE), avoid (§I).
- The review checklist is §AF and Next Steps.

### Sources consulted
- SailoAI: https://sailoai.com/
- Zoho Agent Studio: https://www.zoho.com/agents/articles/agent-studio.html ; https://www.destinationcrm.com/Articles/CRM-News/CRM-Across-the-Wire/Zoho-Launches-Zia-Agents-Agent-Studio-and-Agent-Marketplace-167860.aspx
- n8n agent memory: https://blog.n8n.io/ai-agent-memory/
- Dify: https://dify.ai/ ; https://dify.ai/blog/dify-agent-node-introduction-when-workflows-learn-autonomous-reasoning
- Relevance AI: https://relevanceai.com/docs/build/workforces/workforce-features/approvals-and-escalations ; https://relevanceai.com/docs/build/agents/build-your-agent/tools
- Copilot Studio: https://learn.microsoft.com/en-us/microsoft-copilot-studio/whats-new ; https://azurefeeds.com/2026/04/01/agent-evaluation-in-microsoft-copilot-studio-is-now-generally-available/
- Agentforce: https://salesforcedictionary.com/blogs/salesforce-atlas-reasoning-engine-agentforce-2026-guide
- OpenAI AgentKit: https://openai.com/index/introducing-agentkit/ ; https://montanalabs.ai/news/openai-s-agentkit-and-the-eight-month-lifespan-of-agent-builder/
- Vercel AI SDK 6: https://vercel.com/blog/ai-sdk-6
