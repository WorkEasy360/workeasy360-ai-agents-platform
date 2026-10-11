# Deploy runbook

> **Not the current production setup.** This runbook describes the earlier ECS/RDS design. Production now runs on one EC2 instance with the shared Aurora cluster: see [deploy/README.md](../../deploy/README.md).

Terraform lives in `infra/terraform` (`envs/staging`, `envs/prod`, shared `modules/platform`). The pipeline is `.github/workflows/deploy.yml`. Names: `P=we360-agents-<env>`.

## First-time setup (staging first, then prod)

1. **Prerequisites (manual, once):**
   - Remote state: an S3 bucket (versioned, encrypted) and a DynamoDB table with key `LockID`. Fill in the placeholders in `envs/*/backend.tf`.
   - ACM certificate in **ap-south-1** for the app domain (DNS-validated). If you use CloudFront, also one in **us-east-1**.
   - Decide: new VPC (`create_vpc = true`) or existing VPC. An existing VPC needs NAT egress on its private subnets and at least 2 AZs.
2. **Terraform:**
   ```bash
   cd infra/terraform/envs/staging
   cp terraform.tfvars.example terraform.tfvars   # edit
   terraform init && terraform plan -out tf.plan && terraform apply tf.plan
   terraform output -json platform
   ```
   - Services are created with image tag `bootstrap`, which does not exist. Tasks fail to pull until the first deploy, which is expected.
   - Confirm the SNS alarm email subscriptions from your inbox.
3. **Set secret values** (Secrets Manager → `we360-agents/<env>/...`). Values never go in Terraform.

   | Secret | Value |
   |---|---|
   | `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
   | `API_KEY_PEPPER` | `openssl rand -base64 32`. **Never change it after launch**: doing so invalidates every API key |
   | `DATABASE_URL`, `DATABASE_URL_ADMIN` | see [database.md](database.md) |
   | `SMTP_USER`, `SMTP_PASSWORD` | SES SMTP credentials (SES console → SMTP settings → Create SMTP credentials) |
   | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | platform provider keys (set spending caps in each provider console) |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client; redirect URI `https://<domain>/api/auth/callback/google` |

   ```bash
   aws secretsmanager put-secret-value --secret-id we360-agents/staging/BETTER_AUTH_SECRET --secret-string "$(openssl rand -base64 32)"
   ```
   ECS refuses to start a task when an injected secret has no value. Only the optional secrets listed in `optional_secrets_enabled` (tfvars) are injected, so list only those you have set.
4. **Create the DB roles:** see [database.md](database.md#one-time-create-the-app-roles-before-the-first-migration).
5. **GitHub:** create the Environments `staging` and `prod` (give `prod` required reviewers). On each, set the variable `AWS_DEPLOY_ROLE_ARN` to the Terraform output `github_deploy_role_arn`. Optionally set `AWS_REGION`.
6. **First deploy:** push to `main`, or run *Deploy* manually with `staging`. It runs migrations, then rolls out web, api and worker.
7. **Seed catalog data** (plans, models, flags): see database.md, "Seed".
8. **First super admin.** Use ECS Exec, so the password does not end up in task overrides or CloudTrail:
   ```bash
   TASK=$(aws ecs list-tasks --cluster $P --service-name $P-api --query 'taskArns[0]' --output text)
   aws ecs execute-command --cluster $P --task $TASK --container api --interactive --command "/bin/sh"
   # inside the container:
   node dist/scripts/create-admin.js --email you@workeasy360.com --name "Your Name" --password '<12+ chars>'
   ```
   Sign in, enable 2FA (required in production), then change the password. After this you can set `enable_execute_command = false` for prod if you don't want ECS Exec available.
9. **SES:**
   - Verify the domain identity. DKIM CNAMEs are created automatically when `route53_zone_id` is set. Otherwise create them from the output `ses_dkim_tokens`. Add SPF and DMARC records.
   - **Request production access** (SES console → Account dashboard). Until it is granted, mail only reaches verified addresses. Approval can take days, so do it in week 1.
10. **DNS:** point the domain at the ALB (or CloudFront) if Terraform is not managing Route 53.
11. **Smoke test:** sign up → verify email → create an agent → upload a document (the worker ingests it) → chat in the playground → embed the widget on a test page.

For **prod**, repeat steps 1–10 in `envs/prod`. If prod shares the AWS account with staging, keep `create_ecr_repositories`, `create_ses_identity` and `create_github_oidc_provider` set to `false`.

## Normal deploys

- **Staging:** merge to `main`. The workflow builds `we360-agents-api:<sha>` and `we360-agents-web:<sha>`, runs migrations, updates the services and waits until they are stable. If a new revision fails health checks, the ECS circuit breaker rolls it back and the workflow fails.
- **Prod:** Actions → Deploy → Run workflow → `prod`, on the commit already verified in staging. Its images already exist, so the build is skipped and the exact staging images are promoted. A reviewer approves the `prod` environment.
- Config changes (env vars, sizes) go through `terraform apply`. Terraform registers a new task definition revision but does **not** roll the services. The next pipeline deploy copies the family's latest revision, so it picks the change up. To apply a change now, re-run Deploy.

## Rollback

Application rollback means going back to the previous task definition revision:

```bash
aws ecs list-task-definitions --family-prefix $P-api --sort DESC --max-items 5
aws ecs update-service --cluster $P --service $P-api    --task-definition $P-api:<prev>
aws ecs update-service --cluster $P --service $P-worker --task-definition $P-worker:<prev>
aws ecs update-service --cluster $P --service $P-web    --task-definition $P-web:<prev>
aws ecs wait services-stable --cluster $P --services $P-api $P-worker $P-web
```

Or re-run *Deploy* from the last good commit. Images are immutable, and the last 30 per repo are kept.

- **Migrations are not rolled back.** They must be backward compatible, so old code keeps working on the new schema. If a migration damaged data, use the restore steps in database.md.
- **Agent versions are separate.** A platform rollback does not change tenants' published agent versions. Customers restore those in the builder ("make an old version live").

## App settings for AWS (done in the app)

1. The API image trusts the RDS CA (`NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem`), so connection strings can use `sslmode=verify-full`.
2. The seed ships in the image: `node dist/scripts/seed.js` (insert-only).
3. Uploads use SSE-KMS with the platform key (`KMS_KEY_ID`).
4. With CloudFront in front of the ALB, set `TRUST_PROXY_HOPS=2` on the api service so per-IP rate limits see real client IPs.
5. The Google button is a build-time flag: set the GitHub variable `NEXT_PUBLIC_GOOGLE_LOGIN=true` (the deploy workflow passes it as a build-arg).
