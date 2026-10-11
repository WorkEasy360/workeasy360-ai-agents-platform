# Production runbook: WorkEasy360 AI Agents

One EC2 instance (Stockholm, `eu-north-1`, the same region and VPC as the database) runs everything except the database, with Docker Compose:

| Container | What it does |
|---|---|
| `nginx` | HTTPS on 80/443 (Let's Encrypt); `/api/*` → api, everything else → web |
| `certbot` | renews the certificate twice a day |
| `web` | Next.js app (also the hosted chat pages and widget frames) |
| `api` | Express API; connects to the database as **agents_app** (row-level security applies) |
| `worker` | background jobs: document ingestion, emails, retention; connects as **agents_owner** |
| `redis` | queues and rate limits (on the instance, persisted to a Docker volume) |
| `migrate` | one-off release step: migrations + catalog rows, run by `deploy.sh`, never at app start |

Other pieces:
- **Database:** the **shared Aurora PostgreSQL 18 cluster** in `eu-north-1`. Other WorkEasy360 products live in it (schemas `public`, `helpdesk`, `hrms`). This app may only touch schema **`agents`**, with its own roles `agents_app` and `agents_owner`.
- **AWS services, through the instance role** (no access keys):
  - email through **Amazon SES**
  - uploaded documents in **S3**
  - customer secrets encrypted with **KMS**

**How a release ships:** pushing to `main` runs CI (tests, dependency audit, secret scan, migration check). When CI passes, **Deploy**:
1. builds the images on GitHub and pushes them to GHCR;
2. copies `deploy/` and the migrations to the server over SSH;
3. runs [scripts/deploy.sh](scripts/deploy.sh);
4. checks the live site.

## Non-negotiables
- **The database is shared:**
  - nothing may change outside schema `agents`
  - never connect the app as `postgres`
  - never run `drizzle-kit push`, a reset, a drop or demo seeds against Aurora
  - `deploy.sh` compares table counts per schema before and after migrating, and stops if anything outside `agents` changed
- **Migrations:**
  - they run only as the one-off `migrate` step
  - they must not name a schema
  - `scripts/check-migrations.sh` enforces this in CI and on every deploy
- **Secrets:**
  - production settings live only in `~/agents/deploy/.env` on the server (`chmod 600`), never in git
  - random values are generated on the server (`openssl rand -hex 32`)
- **Other servers:** don't touch the HRMS server (52.66.103.213) or other products' data.

## One-time setup

### 1. EC2 instance
- **Instance:** Ubuntu 24.04, `t3.small` (2 GB RAM; the bootstrap adds 2 GB swap). Use `t3.medium` if many large documents are uploaded.
- **Elastic IP:** attach one.
- **Security group inbound:** 22, 80 and 443.
  - 22 must be open to `0.0.0.0/0`, because GitHub Actions connects from changing addresses. Sign-in is by key only.
  - Port 80 is needed for Let's Encrypt and the HTTPS redirect.
- **Bootstrap:** installs Docker and the Compose plugin, and enables the firewall for 22/80/443.
  ```bash
  scp -i <key>.pem -r deploy ubuntu@<ip>:~/agents/deploy   # or let the first Deploy run ship it
  ssh -i <key>.pem ubuntu@<ip> 'sudo bash ~/agents/deploy/scripts/bootstrap-ec2.sh'
  ```

### 2. KMS key, S3 bucket, IAM role (console, region **Europe (Stockholm)**)
1. **KMS key:** KMS → Customer managed keys → **Create key**.
   - Choose Symmetric, then Encrypt and decrypt.
   - Alias: `agents-prod`.
   - Key administrators: you. Key users: leave empty for now.
   - Finish, then copy the **key ARN**.
2. **S3 bucket:** S3 → **Create bucket**.
   - Name, for example `workeasy360-agents-documents`; Region: Stockholm (eu-north-1).
   - **Block all public access**: on. Versioning: optional.
   - Default encryption: SSE-KMS with the `agents-prod` key. The app also requests it on every upload.
3. **IAM role:** IAM → Roles → **Create role**.
   - Trusted entity: *AWS service*, use case **EC2**. Next.
   - Skip the managed policies. Name it `agents-ec2`, then Create role.
   - Open the role → Add permissions → **Create inline policy** → JSON.
   - Paste [iam/instance-policy.json](iam/instance-policy.json) and replace:
     - `REPLACE_MAIL_FROM_ADDRESS`: the bare sender address, e.g. `no-reply@workeasy360.com`
     - `REPLACE_KMS_KEY_ARN`
     - `REPLACE_BUCKET` (two places)
   - Policy name `agents-app`, then Create.
4. **Attach the role to the instance:** EC2 → Instances → select the instance → Actions → Security → **Modify IAM role** → `agents-ec2` → Update IAM role.
5. **Metadata hop limit 2.** Without this, the containers can't reach the role's credentials under IMDSv2.
   - EC2 → Instances → select → Actions → Instance settings → **Modify instance metadata options**.
   - Instance metadata service: Enabled. IMDSv2: **Required**. **Metadata response hop limit: 2**. Save.
   - Or with the CLI:
     ```bash
     aws ec2 modify-instance-metadata-options --region eu-north-1 --instance-id <i-...> \
       --http-endpoint enabled --http-tokens required --http-put-response-hop-limit 2
     ```

### 3. Amazon SES (email)
- **Region:** SES identities are per region. Use the region where `workeasy360.com` is already verified, if it is: SES → Identities shows "Verified". That region becomes `SES_REGION`.
- **Otherwise, verify in `eu-north-1`:**
  - **Domain (recommended):**
    1. SES → Identities → Create identity → Domain → `workeasy360.com`.
    2. Choose Easy DKIM, RSA 2048.
    3. Add the **3 CNAME records** SES shows at your DNS provider.
    4. Wait for "Verified", usually minutes to a few hours.
  - **Single sender:** Create identity → Email address → `no-reply@workeasy360.com`, then click the link SES emails to that mailbox. The mailbox must exist.
- **Sandbox:** a new SES account is in the **sandbox**: it can only send to verified addresses, 200 per day. To email real users: SES → Account dashboard → **Request production access** (transactional email; describe sign-up, invitation and password-reset emails). Approval usually takes about a day.
- **Until SES is ready, leave `SES_REGION` unset.** The app still works:
  - accounts need no verification, and sign-up stays invitation-only
  - admins copy invitation links from Settings → Members
  - platform admins create password-reset links (Admin → Users → user → *Password reset link*)

### 4. Database (once, as the Aurora admin)
**Prove nothing else changes.** Run this before and after the setup; only `agents` may appear or change:
```bash
docker run --rm -i -e PGPASSWORD postgres:18-alpine \
  psql "host=<writer-endpoint> dbname=postgres user=postgres sslmode=require" -At -F ' ' < sql/00-table-counts.sql
```
**Create the roles and schema** with [sql/01-create-roles-and-schema.sql](sql/01-create-roles-and-schema.sql). Its header has the exact command:
- psql runs in a throwaway container, and the admin password is typed at a prompt, never stored.
- The two app passwords are read from `.env`.
- pgvector is created inside schema `agents` only if the database doesn't have it yet. This is the one agreed exception to "no CREATE EXTENSION".
- Afterwards, forget the admin password. The app never uses it.

### 5. Server `.env`
```bash
cd ~/agents/deploy && cp .env.example .env && chmod 600 .env
# generate on the server, paste into .env:
openssl rand -hex 32   # BETTER_AUTH_SECRET
openssl rand -hex 32   # API_KEY_PEPPER
openssl rand -hex 24   # agents_app password    -> DATABASE_URL
openssl rand -hex 24   # agents_owner password  -> DATABASE_URL_ADMIN
```
Then set `DOMAIN`, the Aurora writer endpoint, `KMS_KEY_ID`, `S3_BUCKET`, and later `SES_REGION`. `deploy.sh` refuses to run if any of these is wrong or missing:
- a placeholder is still in the file
- the app would connect as `postgres`
- `sslmode` is missing
- a local-only switch is set

### 6. HTTPS certificate
DNS for `DOMAIN` must point at the Elastic IP. With no domain, use `<ip-with-dashes>.sslip.io`, which needs no DNS. Then:
```bash
cd ~/agents/deploy && bash scripts/init-letsencrypt.sh      # STAGING=1 first to test without rate limits
```

### 7. GitHub
Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `EC2_HOST` | the Elastic IP |
| Secret | `EC2_USER` | `ubuntu` |
| Secret | `EC2_SSH_KEY` | the **deploy key's private key** (its public key is in the server's `~/.ssh/authorized_keys`) |
| Variable | `DOMAIN` | e.g. `16-171-214-145.sslip.io` |

Images go to GHCR (`ghcr.io/workeasy360/agents-api` and `agents-web`). The workflow's own token pulls them on the server, then logs out again.

### 8. First release and first admin
Push to `main` (or Actions → Deploy → Run workflow). Then create your platform admin account. Sign-up is invitation-only, and staff accounts come from this command:
```bash
cd ~/agents/deploy
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
docker compose -f docker-compose.prod.yml run --rm -e ADMIN_PASSWORD api node dist/scripts/create-admin.js --email you@workeasy360.com --name "Your Name"
unset ADMIN_PASSWORD
```
Sign in, turn on two-factor authentication (required for platform admins), create your organization, and invite your team from Settings → Members.

## Operations (on the server, in `~/agents/deploy`)

| Task | Command |
|---|---|
| Status | `docker compose -f docker-compose.prod.yml ps` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f --tail=200 api` (or `worker`, `web`, `nginx`) |
| Running release | `grep IMAGE_TAG .env` |
| Health | `curl -s https://$DOMAIN/api/health` (503 if the database or Redis is unreachable) |
| Roll back | Actions → Deploy → an earlier successful run → **Re-run all jobs** |
| Code-only redeploy | `SKIP_MIGRATE=1 bash scripts/deploy.sh` (uses the tag recorded in `.env`) |
| After editing `.env` | `docker compose -f docker-compose.prod.yml up -d api worker` |
| Open public sign-up | `ALLOW_PUBLIC_SIGNUP=true` in `.env`, then the command above |

Notes:
- **Rollbacks:** migrations are not reversed, so a migration must keep working with the previous release. Add columns; don't drop them in the same release.
- **Downtime:** a deploy restarts the containers, so expect a few seconds of downtime.
- **Latency:** the server and the database are in the same region, about 1 ms per round trip. The code still keeps round trips low (one round trip to start each tenant transaction; cached plan limits, model catalog and workspace; single-statement summaries), so it would also cope with a database further away.
