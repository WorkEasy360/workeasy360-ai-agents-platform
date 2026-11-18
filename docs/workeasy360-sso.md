# Sign-in with WorkEasy360 Accounts

WorkEasy360 Agents can sign people in with **WorkEasy360 Accounts**, the one identity provider of the WorkEasy360 product family. Agents never sees a WorkEasy360 password. It receives an ID token that names:

- the person (`sub`);
- the WorkEasy360 organization they chose (`organization_id`);
- this product (`product_code`, default `workeasy_agents`).

Agents then keeps its own Better Auth session, authorizes on organization, role and entitlement (never on `sub` alone), asks WorkEasy360 whether the organization is still entitled, and ends the session when WorkEasy360 says so (back-channel logout).

**Agents is a relying party, not an identity provider.** The blueprint's §0.3 options are both rejected: Agents does not become a shared login with Better Auth's OIDC provider plugin (that would be a second identity provider next to WorkEasy360 Accounts), and it does not link accounts by verified email.

WorkEasy360 sign-in is **off** until `WORKEASY360_ISSUER` is set. Email + password and Google sign-in keep working unless `WORKEASY360_SSO_ONLY=true` ([Migration](#existing-accounts-and-migration)).

## What happens, step by step

| Step | What Agents does | Where |
|---|---|---|
| Start | `GET /api/auth/workeasy360/start[?organization=<uuid>][&returnTo=/path]`. Generates state, nonce and a PKCE S256 verifier and stores them **in PostgreSQL** (`workeasy360_login_flows`, 10 minutes, keyed by a hash). The browser holds only a random flow id in an httpOnly, SameSite=Lax cookie (`__Host-we360_w360_flow` over https). The launcher's organization is forwarded as the `organization` hint. | `apps/api/src/workeasy360/plugin.ts`, `client.ts` |
| Callback | `GET /api/auth/workeasy360/callback`. **Takes** (deletes) the flow before anything else, so it is used once. Compares the state in constant time. | `plugin.ts`, `store.ts` |
| Code exchange | openid-client 6 `authorizationCodeGrant` with the PKCE verifier. Client authentication is **`private_key_jwt`**: the assertion has `iss = sub = client id`, **`aud` = the token endpoint**, a 60 s lifetime and a fresh `jti`, signed with `WORKEASY360_PRIVATE_KEY_FILE` (kid `WORKEASY360_KEY_ID`). No client secret exists. | `client.ts` |
| ID token | Verified **again by Agents with jose against the provider's key set** (`jwks_uri`): key by `kid`, algorithm from an allow-list (RS256, ES256), `iss` exactly `WORKEASY360_ISSUER`, `aud` exactly the client id, `exp`/`iat` with 30 s skew, `typ` = `id_token`, `nonce`, `product_code` = `WORKEASY360_PRODUCT_CODE`, `organization_id` present, `email_verified` = true. | `client.ts` `verifyIdToken` |
| Launcher check | If the sign-in started with `?organization=`, the token must name that organization (`wrong_organization` otherwise). | `plugin.ts` |
| Entitlement | Asks the entitlement endpoint from discovery (`workeasy360_entitlement_endpoint`) for the organization **and the person** (`subject`), with its own `private_key_jwt` assertion. A denial ends the sign-in with the reason. | `entitlements.ts` |
| Person | Linked on **(issuer, sub)** in `workeasy360_identities`, never on email. A first sign-in creates the Agents user (email verified). | `store.ts` `provisionSignIn` |
| Organization | Maps `organization_id` to one Agents organization (`workeasy360_organizations`). The organization's first sign-in creates it, with its default workspace, unless `WORKEASY360_PROVISION_TENANTS=false`. An existing Agents organization is linked with an operator command. | `store.ts` |
| Membership | An existing membership keeps its role. A new one is `owner` in an organization with no members yet, `WORKEASY360_DEFAULT_ROLE` (`member`) otherwise. | `store.ts` |
| Session | Any session the browser already held ends. A new **Better Auth session** is created (same table, same signed cookie) with the WorkEasy360 issuer, `sub`, `sid`, organization, the one Agents organization it may use, and the ID token (kept only as `id_token_hint`, never returned to the browser). The cookie is Better Auth's: httpOnly, `__Secure-better-auth.session_token` in production, host-only, never a `.workeasy360.com` cookie. | `plugin.ts`, `apps/api/src/auth/auth.ts` |

Every failure lands on `/login?sso_error=<code>` (a fixed vocabulary, `SsoErrorCode` in `plugin.ts`; the sign-in page shows one message per code). Codes, tokens, state and nonce are never logged.

Because the session is an ordinary Better Auth session, every existing route (`requireSession`, `requireTenant`, `requireRole`, the super admin API) keeps working unchanged.

## Authorization: organization and role, never `sub` alone

- A WorkEasy360 session reaches **only** the Agents organization its token named. `X-Org-Id` for any other organization answers 404, exactly as for a non-member, even when the same person is a member there. `GET /api/v1/me` lists only that organization.
- Better Auth's organization endpoints refuse a WorkEasy360 session that names another organization, creates or deletes an organization, or accepts an invitation (403 `workeasy360_organizations` / `workeasy360_other_organization`). Organizations and who belongs to them come from WorkEasy360.
- Inside the organization, roles decide, as before (`owner` / `admin` / `member`).

## Admin dashboard: Agents' own second factor

WorkEasy360 has no MFA today, and its ID token carries no `amr`. Agents never reads an `amr`, missing or present, as proof of a second factor. So **a WorkEasy360 session starts without Agents' second factor**, and the super admin API (`/api/admin/v1`, `requirePlatformRole` in `apps/api/src/middleware/platform-admin.ts`) treats it exactly as it treats a password sign-in:

| Platform admin (`platformRole`) | Password session | WorkEasy360 session |
|---|---|---|
| Two-factor authentication **on** | Better Auth's challenge asked for the TOTP or a backup code before the session existed: admin works. | 403 **`two_factor_step_up_required`** until **this session** presents the TOTP or a backup code (below). Then admin works for this session only. |
| Two-factor authentication off, `ADMIN_REQUIRE_2FA` on (production default) | 403 `two_factor_required` | 403 `two_factor_required` (unchanged) |
| Two-factor authentication off, `ADMIN_REQUIRE_2FA=false` | Admin works | Admin works (unchanged) |

**The step-up** is Better Auth's own two-factor verification, sent with the WorkEasy360 session cookie:

```
POST /api/auth/two-factor/verify-totp          { "code": "123456" }
POST /api/auth/two-factor/verify-backup-code   { "code": "abcde-12345" }
```

With a session, Better Auth only checks the code against the user's own secret (a backup code is used up) and opens no new session. `apps/api/src/workeasy360/step-up.ts` (called from `auth.ts` hooks) then stamps that one session (`session.two_factor_verified_at`, migration `0003`). Another session, even of the same person in another browser, must step up itself; a new WorkEasy360 sign-in always starts without it.

- **Wrong codes:** Better Auth's sign-in challenge counts wrong codes per account, but its session mode does not. A WorkEasy360 step-up spends the same per-account budget with Better Auth's defaults: 10 wrong codes in a row lock the factor for 15 minutes (429 `ACCOUNT_TEMPORARILY_LOCKED`), on top of the per-IP limit (5 a minute) on these endpoints. A right code restarts the count.
- **SSO-only:** these two endpoints stay open for WorkEasy360 sessions (they sign nobody in), and stay refused (403 `workeasy360_sso_only`) for anyone else.
- **Web:** the admin pages show the code prompt on `two_factor_step_up_required` (`apps/web/src/components/admin/step-up.tsx`).
- A WorkEasy360 user can only have two-factor authentication if the account had it before `link-user`, or turned it on with the account's password: an account created by WorkEasy360 sign-in has no password, and so no admin rights either unless an operator grants them.

## Entitlement, on WorkEasy360's schedule

Every tenant request (`requireTenant`) to an Agents organization linked to WorkEasy360 asks `entitlementRefusal` (`apps/api/src/workeasy360/access.ts`). This includes password and Google sessions of members of a linked organization (asked per organization), the organization's **API keys**, and its **public deployments** (hosted page and widget answer `agent_unavailable`).

- **Cache:** an answer is kept for `min(revalidate_after, 900)` seconds (at least 30) in PostgreSQL (`workeasy360_entitlements`), shared by every API instance, plus each process's own copy. WorkEasy360 is never asked per request.
- **Denial:** re-asked after 60 s; until then, and through any outage, it stands. A known denial is kept without expiry, so neither a restart nor an outage hands access back. The answer is 403 `workeasy360_access_ended` with `errors.reason` (`not_entitled`, `expired`, `suspended`, `membership_inactive`, `no_seat`). The session stays valid, so the person sees why and can sign out.
- **Read-only:** while `write_allowed` is false, writes answer 403 `workeasy360_read_only`. Reads, knowledge search and exports still work.
- **Outage:** a 5xx, a 429, a timeout or a network error is never a denial. The last answer stands; with none yet, access continues. WorkEasy360 is asked again after 60 s.
- **Refusal of this product's client:** a 400, 401 or 403 from the entitlement endpoint (a revoked credential, a suspended integration) fails **closed** for the whole client: for 60 s every question answers 403 `workeasy360_access_unverified` and every sign-in `sso_error=access_unverified`; a 429 within five minutes of the refusal counts as one. Then one question is asked again.
- **When the person arrives:** the callback asks afresh; a denial ends the sign-in.

Agents' own plans and limits stay as they are. An organization created by a first WorkEasy360 sign-in gets `WORKEASY360_TENANT_PLAN` (default `free`); the Agents super admin sets its plan as today ([What remains](#what-remains-before-go-live)).

## Back-channel logout, and the session check on every request

`POST /api/auth/workeasy360/backchannel-logout`, form field `logout_token`. Server to server: no cookie and no CSRF token; the provider's signature is the authentication.

The logout token is verified with jose against the provider's key set:

- JOSE `typ` is `logout+jwt`, and a `typ` claim, if present, is `logout_token`;
- the signature is by `kid` (RS256 or ES256);
- `iss` is exactly ours and `aud` is our client id;
- `iat` is not in the future and at most 10 minutes old, and `exp` has not passed;
- the back-channel-logout event is present, and there is **no `nonce`**;
- `sub` and/or `sid` are present, and so is a `jti`.

Then, in **one PostgreSQL transaction** (`store.ts` `endSessions`):

1. the `jti` is recorded once per issuer (`workeasy360_logout_tokens`);
2. with `sid`, the sessions that WorkEasy360 sign-in opened are **deleted** (narrowed to `sub` when both are present); with `sub` alone, every WorkEasy360 session of that person.

The receiver answers **200** when the token verifies, including a **duplicate** (which changes nothing), **400** `invalid_request` for an invalid token, and **503** when the key set or the database cannot be reached (nothing recorded, so WorkEasy360 delivers again).

**The per-request check:** Better Auth reads every session from the database on every request: `session.cookieCache` is explicitly disabled and there is no secondary storage (`auth.ts`). A session deleted by a logout token delivered to *any* instance is refused (401) by *every* instance on its next request. `requireSession` also refuses a WorkEasy360 session when WorkEasy360 sign-in is off or the session's issuer is not `WORKEASY360_ISSUER`.

## Signing out

- **Sign out** (Better Auth `POST /api/auth/sign-out`) ends the Agents session only.
- **Sign out of WorkEasy360 too** (`POST /api/auth/workeasy360/sign-out`, shown only for a WorkEasy360 session) first ends the Agents session, then answers `{ redirect }`: WorkEasy360's `end_session_endpoint` with `id_token_hint`, `client_id` and the registered `WORKEASY360_POST_LOGOUT_REDIRECT_URI`. The browser goes there and WorkEasy360 asks the person to confirm.

## Existing accounts and migration

**People are keyed on `(issuer, sub)`. Nothing is ever merged by email, silently or otherwise.**

| Existing account | On the person's first WorkEasy360 sign-in |
|---|---|
| Password or Google account **with the same email address** | **Refused** with `sso_error=account_exists` ("sign in with your password, or ask support to connect it"). Agents' `user.email` is unique, and taking an account over because an email matches is exactly what the contract forbids. To carry the account (its memberships, roles and 2FA) over, an operator runs `link-user` after checking that the two belong to the same person; from then on WorkEasy360 sign-in reaches that account. The password and Google sign-in of the account keep working while `WORKEASY360_SSO_ONLY` is false. |
| Password or Google account with a different email address | Untouched. The WorkEasy360 person is a separate user. |
| A WorkEasy360 identity under a **previous issuer name** (e.g. `https://auth.workeasy360.com` to `https://accounts.workeasy360.com`, ADR-067) | **Refused** with `sso_error=identity_conflict`, and its sessions are refused per request, instead of silently creating a second account for the same `sub`. Run `move-issuer` in the same release that changes `WORKEASY360_ISSUER`. |
| An Agents organization that should receive a WorkEasy360 organization's sign-ins | Run `link-organization` **before** the organization's first sign-in (or afterwards with `--replace-empty`). Its password members are then subject to that organization's entitlement too. |

**No side doors for WorkEasy360 users** while WorkEasy360 sign-in is on (`WORKEASY360_ISSUER` set), even with `WORKEASY360_SSO_ONLY=false`. A user created by a WorkEasy360 sign-in has a verified address (`emailVerified: true`), and Better Auth would otherwise let a Google sign-in with that address link to it implicitly, and a password reset add a password. Either way the person would get a session that WorkEasy360 did not open, that a back-channel logout does not end, and that is checked per organization only. So for any user with a WorkEasy360 identity (`auth.ts`, `databaseHooks.account.create` and `sendResetPassword`):

- a new Google account (implicit linking at Google sign-in, or `link-social`) is refused: Better Auth lands on its error page ("unable to link account");
- a password reset for an account without a password sends no link (the answer is the same as for any address), and a reset that would create a password answers 403 `workeasy360_account`;
- what the account already had stays as it is: an account linked by `link-user` keeps its password (it can still reset it) and any Google sign-in it already had, until `WORKEASY360_SSO_ONLY=true` refuses both.

**With `WORKEASY360_SSO_ONLY=true`:**

- password sign-in, sign-up, password reset, email verification sign-in, two-factor sign-in and Google sign-in answer 403 `workeasy360_sso_only`;
- every session opened another way is refused at once (401 `workeasy360_sign_in_required`), on `/api/v1`, `/api/admin/v1` and Better Auth's endpoints alike (sign-out still works);
- the sign-in and sign-up pages show only "Continue with WorkEasy360".

Switch it on only after every customer's owners can sign in with WorkEasy360, and after platform staff who use `/admin` are linked to their WorkEasy360 identity with `link-user` (their 2FA flag stays on their account, so `ADMIN_REQUIRE_2FA` keeps working).

**Removing someone:** WorkEasy360 decides who belongs to a linked organization. Removing a member in Agents (Settings → Members) removes their role there, but their next WorkEasy360 sign-in adds them back with the default role. To keep someone out, remove them (or their seat) in WorkEasy360: the entitlement check with `subject` then ends their open Agents session within one `revalidate_after` window, and the next sign-in is refused.

## Register in Super Admin

The platform catalog has **no `workeasy_agents` product yet**: create it first (Products → Add product), or set `WORKEASY360_PRODUCT_CODE` to whatever code it gets. Then, under Product → Integration (`docs/universal-sso/onboarding-a-product.md` in the platform repository):

| Field | Value |
|---|---|
| Launch URL | `https://agents.workeasy360.com/api/auth/workeasy360/start` (the launcher appends `?organization=<uuid>`) |
| Redirect URI | `https://agents.workeasy360.com/api/auth/workeasy360/callback`, exactly |
| Back-channel logout URI | `https://agents.workeasy360.com/api/auth/workeasy360/backchannel-logout` (same origin as the redirect URI) |
| Post-logout redirect URI | `https://agents.workeasy360.com/login`, exactly what `WORKEASY360_POST_LOGOUT_REDIRECT_URI` says |
| Login URL | `https://agents.workeasy360.com/login` |
| Scopes | `openid email profile organization`. `email` is required: `email_verified` comes with it. `organization` names an Agents organization created on a first sign-in. |
| Token endpoint auth method | `private_key_jwt` |
| Sign-in mode | `sso_optional` while password sign-in is on (login URL above); `sso_only` once `WORKEASY360_SSO_ONLY=true`. |
| Credential | The **public** key below. Its credential id is `WORKEASY360_KEY_ID`. |

Or, as a platform operator: `manage.py connect_product_sso --actor <staff email> --product workeasy_agents --redirect-uri https://agents.workeasy360.com/api/auth/workeasy360/callback --public-key-file workeasy360-agents.pub.pem`.

Generate the key pair on a trusted machine. The private key goes only to the server's secret store, never into the repository (it is public) or an image:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out workeasy360-agents.pem   # private: never commit
openssl pkey -in workeasy360-agents.pem -pubout -out workeasy360-agents.pub.pem              # public: paste into Super Admin
```

RSA keys (RS256) work too.

### Hostname: `agents.workeasy360.com`

WorkEasy360 activates an integration only once **every hostname in it is proven by a DNS TXT record** (ADR-070). Agents runs today on `16-171-214-145.sslip.io`; nobody here controls the `sslip.io` zone, so that name **cannot be proven**. The product's hostname is **`agents.workeasy360.com`** (free in DNS on 2026-11-18):

1. DNS: `agents.workeasy360.com` A → the EC2 Elastic IP (16.171.214.145), and the TXT record Super Admin shows under Products → Integration → Domains: `_w360-product-verify.agents.workeasy360.com TXT "w360-product-verify=<value>"`. Keep the TXT record published (re-checked every six hours).
2. Server: `DOMAIN=agents.workeasy360.com` in `~/agents/deploy/.env` (nginx and Let's Encrypt follow it; `APP_URL` is derived from it), then redeploy.
3. Verify the domain in Super Admin, then activate.

## Environment

All names are those of the WorkEasy360 integration kit's `.env.example`. The API refuses to start when they are inconsistent (`apps/api/src/workeasy360/config.ts`; messages name the variable, never its value).

| Variable | Default | Meaning |
|---|---|---|
| `WORKEASY360_ISSUER` | (empty: off) | Exactly the issuer WorkEasy360's discovery document names, **no trailing slash**. https; plain http only for a loopback issuer (`127.0.0.1`, `localhost`) outside production. |
| `WORKEASY360_CLIENT_ID` | | The client id from the registration. |
| `WORKEASY360_PRODUCT_CODE` | `workeasy_agents` | Must equal the ID token's `product_code`. |
| `WORKEASY360_REDIRECT_URI` | `<APP_URL>/api/auth/workeasy360/callback` | Must be exactly that address. |
| `WORKEASY360_POST_LOGOUT_REDIRECT_URI` | `<APP_URL>/login` | On the `APP_URL` origin; registered exactly. |
| `WORKEASY360_KEY_ID` | | The credential id (`kid` of the client assertion). |
| `WORKEASY360_PRIVATE_KEY_FILE` | | PEM file, RSA or EC P-256, mounted into the api container. |
| `WORKEASY360_SCOPES` | `openid email profile organization` | Must include `openid` and `email`. |
| `WORKEASY360_SSO_ONLY` | `false` | `true`: WorkEasy360 is the only way in. |
| `WORKEASY360_DEFAULT_ROLE` | `member` | Role of someone joining an organization that already has members (`member` or `admin`). |
| `WORKEASY360_PROVISION_TENANTS` | `true` | `false`: only organizations linked by an operator can be signed in to (`sso_error=no_tenant`). |
| `WORKEASY360_TENANT_PLAN` | `free` | Agents plan of an organization created by a first sign-in. |
| `WORKEASY360_PURCHASE_URL` | the issuer | Returned with `workeasy360_access_ended` as the way to get the product. |

`WORKEASY360_ISSUER`, `CLIENT_ID`, `KEY_ID` and `PRIVATE_KEY_FILE` must all be set, or none. On the server, mount the key read-only into the api service, for example `- ./secrets/workeasy360-agents.pem:/run/secrets/workeasy360-agents.pem:ro` under `api.volumes` in `deploy/docker-compose.prod.yml` (with `chmod 600` on the host file), and set `WORKEASY360_PRIVATE_KEY_FILE=/run/secrets/workeasy360-agents.pem`. That mount is not in the compose file yet, because it must not exist before the key does.

The web app learns what to show from `GET /api/public/v1/platform` (`workeasy360`, `ssoOnly`); no build-time variable is needed.

## Operator commands

They run as the schema owner (`DATABASE_URL_ADMIN`): locally `pnpm --filter @we360/api workeasy360 <command>`; on the server `docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/workeasy360.js <command>`.

| Command | What it does |
|---|---|
| `link-organization <agents-organization-id> <workeasy360-organization-id> [--replace-empty]` | Sign-ins from that WorkEasy360 organization land in this existing Agents organization. An organization already linked to another WorkEasy360 organization is never re-pointed. If a first sign-in already created an organization for it, the command refuses; `--replace-empty` unlinks and suspends that one if it has no agents, and its WorkEasy360 sessions end. Audited (`organization.linked_to_workeasy360`). |
| `link-user <agents-user-id> <workeasy360-sub> [--issuer <issuer>]` | You vouch that an existing account (password or Google) is this WorkEasy360 person. It then signs in with WorkEasy360 and keeps its memberships, roles and 2FA. Refused when that identity is already linked, or the user already has an identity under this issuer. `--issuer` defaults to `WORKEASY360_ISSUER`. Audited. |
| `move-issuer --from <old> --to <new> [--apply]` | The identity move of an issuer change: every `(old, sub)` becomes `(new, sub)`, and so do live WorkEasy360 sessions. Without `--apply` it only reports. It refuses, listing them, when a subject already has a user under the new issuer: two accounts are never merged. |
| `identities` | Linked users and live WorkEasy360 sessions per issuer. |

## Run it locally against a WorkEasy360 provider on `http://127.0.0.1:8031`

1. Run a WorkEasy360 platform locally with issuer `http://127.0.0.1:8031` (the platform repository's local setup).
2. In its Super Admin, create the catalog product `workeasy_agents` and register the integration with:
   - redirect URI `http://localhost:3000/api/auth/workeasy360/callback`;
   - back-channel logout URI `http://localhost:3000/api/auth/workeasy360/backchannel-logout`;
   - post-logout URI `http://localhost:3000/login`;
   - scopes `openid email profile organization`, `private_key_jwt`.
3. Add the public key, activate (loopback hosts need no DNS proof; http redirect URIs are accepted outside production), and grant the product to a test organization.
4. Add to the repository root `.env` (never committed):

   ```dotenv
   WORKEASY360_ISSUER=http://127.0.0.1:8031
   WORKEASY360_CLIENT_ID=<client id>
   WORKEASY360_KEY_ID=<credential id>
   WORKEASY360_PRIVATE_KEY_FILE=C:/path/outside/the/repo/workeasy360-agents.pem
   ```

5. `pnpm services:up && pnpm db:migrate && pnpm db:seed && pnpm dev`.
6. Open `http://localhost:3000/login` and choose **Continue with WorkEasy360**, or open `http://localhost:3000/api/auth/workeasy360/start?organization=<organization uuid>` as the launcher would.

The platform must reach `http://localhost:3000/api/auth/workeasy360/backchannel-logout` from where it runs (Next.js proxies `/api/*` to the API on :4000). If it runs in Docker, use an address of the host it can reach and register that.

### Proving 200 vs 401 from a script

The protected endpoint is **`GET /api/v1/me`** on the web origin. The credential is the **Better Auth session cookie** set by the callback: `better-auth.session_token` over http, `__Secure-better-auth.session_token` in production. Copy its whole value (it is `<token>.<signature>`, URL-encoded) from the browser's dev tools.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: better-auth.session_token=<value>' http://localhost:3000/api/v1/me   # 200
# Sign out everywhere in WorkEasy360 (or let it deliver a logout token), then the same call:
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: better-auth.session_token=<value>' http://localhost:3000/api/v1/me   # 401
```

In production: `curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: __Secure-better-auth.session_token=<value>' https://agents.workeasy360.com/api/v1/me`.

`GET /api/v1/workspaces` with `X-Org-Id: <organization id>` answers 200 while the organization is entitled, and 403 `workeasy360_access_ended` once it is not.

## Tests

`apps/api/test/workeasy360.test.ts` runs against a fake WorkEasy360 provider (`apps/api/test/workeasy360-fake-provider.ts`) whose keys are generated when it starts. It serves discovery, the key set, authorize, token (checking `private_key_jwt` with `aud` = the token endpoint, and PKCE, as the platform does), entitlement and end-session. The tests cover:

- the happy path (the authorization request, the client assertion, the entitlement question, the person, organization, membership and session);
- a wrong issuer, audience, signature, nonce or `typ`; a wrong product; a missing organization; an unverified email; another organization than the launcher asked for;
- PKCE (no request without an S256 challenge; a code exchanged without its verifier is refused), a forged state, a replayed callback, a cancelled sign-in;
- not entitled at sign-in; re-checks: read-only, outage, denial, renewal, a person whose membership ended, refusal of the client (fail closed), API keys;
- cross-organization access refused (same person in two organizations, and somebody else's organization), Better Auth's organization endpoints, no provisioning when switched off;
- logout tokens: by `sid`, by `sub`, a duplicate, a replayed `jti`, and forged ones (another key, another issuer, another audience, a wrong `typ`, no event, a nonce, neither `sub` nor `sid`, too old, an ID token, no token);
- **two API instances** (this process and a second `src/server.ts` process configured from the environment) sharing the database: a logout token delivered to either one is refused by both at once; no cookie cache;
- both sign-outs; accounts never merged by email and the operator links; the issuer move; SSO-only; WorkEasy360 switched off;
- the admin dashboard's second factor: a WorkEasy360 session of a two-factor admin refused until it steps up (TOTP or backup code), only for that session, a wrong code refused and counted, the lock, SSO-only, password sessions unchanged, `ADMIN_REQUIRE_2FA` unchanged;
- the side doors: no Google account and no password by reset for a WorkEasy360 user, an operator-linked account's own password kept, other accounts and WorkEasy360 switched off unchanged.

`apps/api/test/workeasy360-config.test.ts` covers the configuration rules.

## What remains before go-live

- Super Admin: create `workeasy_agents`, register the integration, add the public key, verify `agents.workeasy360.com`, grant to a test organization, activate. Then the platform's conformance run (`Accounts/e2e/run_global_logout.py`, extended with Agents).
- DNS and server: `agents.workeasy360.com` A and TXT records, `DOMAIN` switch, the key mount and the `WORKEASY360_*` variables in `~/agents/deploy/.env`.
- Commercial model: Agents keeps its own plans, credits and super admin. Decide how WorkEasy360 plans map to Agents plans (`WORKEASY360_TENANT_PLAN` is one value for every new organization today).
- Existing deployed users: link them (`link-user`, `link-organization`) before switching `WORKEASY360_SSO_ONLY=true`.

## Not covered yet

- **Automatic start** for SSO-only products (integration guide §6b): someone who opens Agents without a session sees the sign-in page with "Continue with WorkEasy360" instead of being sent to WorkEasy360 directly.
- **Self-service linking** ("connect my WorkEasy360 account" while signed in with a password): only the operator command links accounts today.
- `prompt=login` ("confirm it's you") for sensitive actions is not used; Better Auth's own fresh-session rules apply.
- **Google sessions and the admin dashboard (not WorkEasy360's, noted here):** Better Auth's two-factor challenge runs only for email, username and phone-number sign-in, so a Google sign-in of a platform admin with two-factor authentication gets a session without the code. The step-up above applies only to WorkEasy360 sessions. Extending it to Google sessions (stamp sessions that passed the challenge, step up the rest) would also ask existing password sessions to step up once, so it is left as a decision.
- Better Auth's `GET /api/auth/organization/list` still lists every organization the user belongs to; the session can use only its own.
