# Incident playbooks

> **Not the current production setup.** This runbook describes the earlier ECS/RDS design. Production now runs on one EC2 instance with the shared Aurora cluster: see [deploy/README.md](../../deploy/README.md).

Alarms go to the SNS topic `we360-agents-<env>-alerts`. Logs: CloudWatch `/ecs/we360-agents-<env>-{web,api,worker,migrate}`. Super admin: `https://<domain>/admin`. `P=we360-agents-<env>`.

First, every time: say in the team channel who is handling it, note the start time, and check **System health** in super admin plus the ALB 5xx / target health alarms.

## LLM provider outage or rate limits (429/5xx from OpenAI / Anthropic / Google)

1. Confirm: super admin → System health (provider error rates), the provider's status page, and api logs (`429`, `overloaded`, `rate_limit`).
2. Platform-key traffic: in super admin → **Models**, disable the affected models or change the default model to another provider. Tell customers on BYOK keys that their own quota or key is the cause. BYOK never falls back to platform keys, by design.
3. Rate limits (not an outage): ask the provider for a higher tier. Meanwhile, lower heavy orgs' limits (Organizations → overrides) so others keep working.
4. Ingestion backlog builds while embeddings fail. See "Queue backlog" below. Jobs retry 3 times with backoff; re-enqueue failed documents after recovery.

## Cost spike (platform AI spend)

1. Super admin → **Usage & cost**: sort by org and model for today. Find the top spender and the agent or deployment involved.
2. Contain, least disruptive first:
   - disable the specific agent or deployment (abuse via a public widget or hosted page);
   - lower the org's plan or set limit overrides (credits/messages);
   - **suspend** the org (Organizations → Suspend). This is audited.
3. If the cause is platform-wide (a bug or loop): disable the expensive model in **Models**, and cap spend in the provider console.
4. Afterwards, check the WAF rate limit and per-deployment caps, and add an alert threshold.

## Queue backlog (documents stuck in "processing")

1. Super admin → System health → queue depth and failed jobs. Then check the worker: `aws ecs describe-services --cluster $P --services $P-worker` (running count, events) and its logs.
2. Worker crashing (OOM or exceptions): check `stoppedReason` on recently stopped tasks. Raise `worker_memory` or lower `INGEST_CONCURRENCY` (extra_backend_environment), then apply and deploy.
3. Worker healthy but slow: scale out with `aws ecs update-service --cluster $P --service $P-worker --desired-count N` (stays within the autoscaling max), or raise `worker_max_count`.
4. Valkey memory alarm: the policy is `noeviction`, so writes fail when memory is full. Clear old failed jobs from the queue dashboard. Scale the node type if needed (in prod a replica takes over during the change).
5. Downstream cause (embeddings provider down): see the provider playbook. Jobs retry.

## Database CPU high (`rds-cpu` alarm)

1. Performance Insights (RDS console → the instance) → top SQL by load. Or run in psql (database.md): `SELECT query, calls, total_exec_time FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;`
2. Find runaway queries with `SELECT pid, now()-query_start, state, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY 2 DESC;` and cancel one with `SELECT pg_cancel_backend(<pid>);`.
3. If one tenant is driving the load (big knowledge base, API loop), suspend or limit that org in super admin.
4. Short term: scale the instance class (`db_instance_class` → apply; Multi-AZ fails over with a ~1–2 min blip). Long term: add an index, or move retrieval/analytics to a read replica.
5. Also check connection count: (api + worker tasks) × `DB_POOL_MAX` must stay below `max_connections`.

## Compromised API key or credential (rotation)

| What leaked | Action |
|---|---|
| Customer API key (`we360_sk_...`) | The customer revokes it in the app (or super admin disables the deployment). Keys are hashed, so nothing else to rotate |
| Platform LLM key | Create a new key in the provider console → `aws secretsmanager put-secret-value` → force new deployment of api + worker → revoke the old key → check provider usage for abuse |
| SMTP credentials | Create new SES SMTP credentials → update `SMTP_USER`/`SMTP_PASSWORD` → redeploy → delete the old IAM user/key |
| `DATABASE_URL*` passwords | `ALTER ROLE ... PASSWORD` → update the secret → redeploy (database.md). Master password: `aws secretsmanager rotate-secret --secret-id <db_master_secret_arn>` |
| `BETTER_AUTH_SECRET` | Rotate the secret and redeploy. All sessions are invalidated (everyone signs in again) |
| `API_KEY_PEPPER` | **Do not rotate casually**: it invalidates every customer API key. Only for a confirmed leak, with customer notice |
| Google OAuth client secret | Reset it in the Google Cloud console → update the secret → redeploy |
| AWS deploy role misuse | Remove the `AWS_DEPLOY_ROLE_ARN` variable or detach the role policy, review CloudTrail, then rotate as needed |

Force a redeploy of the current version: `aws ecs update-service --cluster $P --service $P-api --force-new-deployment` (repeat for worker and web). Record the incident in the audit log notes.

## KMS key policy (platform key `alias/we360-agents-<env>`)

- What it protects: tenant tool credentials and BYOK keys (envelope encryption), S3 documents, RDS and Valkey storage. **If the key is disabled or scheduled for deletion, the app cannot decrypt credentials, and RDS/S3 data becomes unreadable.**
- The key policy delegates to IAM: account root has `kms:*`. Only the api and worker task roles get `kms:GenerateDataKey` + `kms:Decrypt`. Check who else has access with IAM Access Analyzer or `aws kms get-key-policy --key-id alias/we360-agents-<env> --policy-name default`.
- Someone disabled or scheduled the key: `aws kms enable-key` / `aws kms cancel-key-deletion` immediately. Deletion has a 30-day window in prod and 7 in staging.
- Suspected misuse: review CloudTrail for `Decrypt`/`GenerateDataKey` calls from unexpected principals. Remove the principal's permission, rotate whatever it could reach, and consider re-encrypting tenant secrets with fresh data keys (app-level re-encrypt job).
- Automatic key rotation is on (yearly). Old key material stays available, so existing ciphertexts keep decrypting. No action needed.
- Never edit the key policy to remove the root statement. That can lock the account out of the key.
