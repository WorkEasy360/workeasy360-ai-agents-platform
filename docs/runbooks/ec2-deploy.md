# EC2 deployment runbook

The app runs on one EC2 instance in Mumbai (`ap-south-1`) with Docker Compose:

| Container | Role |
|---|---|
| `caddy` | HTTPS on 80/443 with automatic Let's Encrypt certificates; `/api/*` → api, everything else → web |
| `web` | Next.js |
| `api` | Express API |
| `worker` | BullMQ jobs: document ingestion, retention, cleanup |
| `redis` | queues and rate limits (on the instance, persisted to a Docker volume) |

The database is an existing PostgreSQL server (RDS or Aurora) in another region. Uploaded files go to S3 in Mumbai.

Every push to `main` deploys automatically once CI passes. The **Deploy** workflow:
1. builds the images and pushes them to ECR;
2. runs [infra/ec2/deploy.sh](../../infra/ec2/deploy.sh) on the instance through AWS SSM. No SSH is needed.

> **Latency.** Every API request makes several database round trips. With the database in the US or Europe (about 120–200 ms from Mumbai per round trip), pages and chat start-up will be noticeably slower than with a database in Mumbai or Hyderabad. If it feels slow, moving the database to `ap-south-1` or `ap-south-2` is the fix; no code change is needed, only the URLs in the secret.

## One-time setup

### 1. EC2 instance
- **OS:** Amazon Linux 2023 or Ubuntu 22.04/24.04. The SSM agent is preinstalled on both.
- **Size:** 4 GB RAM or more (for example `t3.medium`). The deploy adds 2 GB of swap on smaller machines.
- **Disk:** 30 GB or more.
- **Elastic IP:** attach one, so the address doesn't change.
- **Security group inbound:** TCP 80 and 443 from `0.0.0.0/0` (Caddy needs port 80 for certificates and redirects). SSH is not required.
- **Outbound:** open, for ECR, S3, the database and model providers.
- Docker, Compose, jq and the AWS CLI are installed by [bootstrap.sh](../../infra/ec2/bootstrap.sh) on the first deploy.

### 2. Database (existing RDS/Aurora in the other region)
- **Engine:** PostgreSQL 15.2 or later (Aurora PostgreSQL or RDS PostgreSQL), which includes pgvector. The migrations enable `vector` and `pg_trgm` as the master user.
- **Network:** the instance must reach port 5432. Either:
  - make the database publicly accessible and allow inbound 5432 **only from the instance's Elastic IP** (`x.x.x.x/32`), or
  - connect the two VPCs with cross-region VPC peering or a Transit Gateway, and keep the database private.
- **TLS:** keep it forced (`rds.force_ssl = 1`; Aurora enforces it through the cluster parameter group). All URLs use `sslmode=verify-full`. The API image trusts the AWS RDS CA bundle, which covers every region.
- The deploy creates the database (if missing) and the `we360_app` and `we360_admin` roles itself, using the master user. You don't run any SQL by hand.

### 3. AWS resources (Terraform, `infra/terraform/envs/ec2`)
This creates the ECR repositories, KMS key, documents bucket, config secret, instance permissions and the GitHub deploy role. Run it from AWS CloudShell in `ap-south-1` or from any machine with Terraform 1.6+ and admin credentials:
```bash
cd infra/terraform/envs/ec2
cp terraform.tfvars.example terraform.tfvars   # fill in instance_id, bucket name, existing role name if any
# edit backend.tf (state bucket) or delete it to keep state locally
terraform init && terraform apply
```
- If Terraform created the instance role, run the `attach_instance_profile_command` it prints.
- If the instance already has a role, set `instance_role_name` and Terraform adds the permissions to that role.
- If the GitHub OIDC provider already exists in the account, set `create_oidc_provider = false`.
- If the ECR repositories already exist, set `create_ecr_repositories = false`.

### 4. App configuration secret
Put one JSON object in the secret named by the `app_secret_id` output (Secrets Manager console → the secret → Retrieve/Set secret value → Plaintext).

Generate random values with `openssl rand -hex 32`. Passwords inside URLs must be URL-encoded; hex passwords need no encoding.

```json
{
  "DATABASE_URL_OWNER": "postgres://<master-user>:<master-password>@<db-endpoint>:5432/we360_agents?sslmode=verify-full",
  "DATABASE_URL": "postgres://we360_app:<new-hex-password-1>@<db-endpoint>:5432/we360_agents?sslmode=verify-full",
  "DATABASE_URL_ADMIN": "postgres://we360_admin:<new-hex-password-2>@<db-endpoint>:5432/we360_agents?sslmode=verify-full",
  "BETTER_AUTH_SECRET": "<hex-32>",
  "API_KEY_PEPPER": "<different-hex-32>",
  "KMS_KEY_ID": "<terraform output kms_key_arn>",
  "S3_BUCKET": "<terraform output documents_bucket>",
  "EMAIL_FROM": "WorkEasy360 Agents <no-reply@your-domain>",
  "SMTP_HOST": "email-smtp.ap-south-1.amazonaws.com",
  "SMTP_PORT": "587",
  "SMTP_USER": "<SES SMTP user>",
  "SMTP_PASSWORD": "<SES SMTP password>",
  "OPENAI_API_KEY": "",
  "ANTHROPIC_API_KEY": "",
  "GOOGLE_GENERATIVE_AI_API_KEY": ""
}
```

Notes:
- **Database URLs:** use the writer (cluster) endpoint for Aurora. The `we360_app` and `we360_admin` passwords are yours to choose; the deploy creates the roles, or resets their passwords to match.
- **Values set by the deploy:** `APP_URL` (`https://<APP_DOMAIN>`) and `AWS_REGION` come from the workflow. `REDIS_URL`, `NODE_ENV` and `TRUST_PROXY_HOPS` are fixed in [docker-compose.yml](../../infra/ec2/docker-compose.yml).
- **Optional keys:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LOG_LEVEL`, `AUDIT_RETENTION_DAYS`.
- **Never set** `MOCK_LLM`, `LOCAL_MASTER_KEY`, `S3_ENDPOINT` or `ALLOW_PRIVATE_EGRESS`. The API refuses to start in production with them.

### 5. DNS
Create an A record for your app domain (for example `agents.workeasy360.com`) pointing at the Elastic IP. Do this before the first deploy, so Caddy can get the certificate.

### 6. GitHub
In the repository, open Settings → Environments → **New environment** `production` (optionally add required reviewers), then add these **Variables**:

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | Terraform output `github_deploy_role_arn` |
| `EC2_INSTANCE_ID` | `i-...` |
| `APP_SECRET_ID` | Terraform output `app_secret_id` |
| `APP_DOMAIN` | `agents.workeasy360.com` (host name only) |
| `AWS_REGION` | optional; default `ap-south-1` |

Until these are set, the Deploy workflow finishes with a "Deploy skipped" warning.

### 7. First deploy and first admin
Run Actions → **Deploy** → Run workflow, or push to `main`. Then create the platform admin.

From the console: EC2 → the instance → Connect → Session Manager. Or use `aws ssm start-session --target i-...`. Then run:
```bash
sudo -i
cd /opt/we360
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
docker compose run --rm -e ADMIN_PASSWORD worker node dist/scripts/create-admin.js --email you@your-domain --name "Your Name"
```

## Operations (on the instance, as root in `/opt/we360`)

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f --tail 200 api` (or `web`, `worker`, `caddy`) |
| Deployed version | `cat current-tag` |
| Roll back to an earlier commit | `bash deploy.sh <full-commit-sha> <registry> <secret-id> ap-south-1 <domain>`. The registry is `<account>.dkr.ecr.ap-south-1.amazonaws.com`; images are kept in ECR (last 30). |
| Restart one service | `docker compose restart api` |
| After changing the secret | re-run the Deploy workflow; it rewrites `app.env` and restarts |

**How deploys behave:**
- A deploy restarts the containers, so expect a few seconds of downtime.
- If the new version fails its health checks, `deploy.sh` switches back to the previous image automatically.
- Migrations are not reversed, so a migration must keep working with the previous version (add columns, don't drop them, in the same release).

## What this setup doesn't cover yet
- **One instance:** an instance or Availability Zone failure means downtime until it's replaced. Redis data lives on the instance volume, so a lost instance loses queued jobs (not customer data, which is in Postgres and S3).
- **Backups:** EBS snapshots of the instance are not needed for data; database backups are handled by RDS/Aurora (check the retention period).
- **Old ECS setup:** the ECS/Fargate Terraform in `infra/terraform/envs/{staging,prod}` is unused by this setup. It stays for a later move to ECS.
