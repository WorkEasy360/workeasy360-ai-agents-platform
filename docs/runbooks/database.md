# Database runbook (RDS PostgreSQL 16)

Names below use `ENV=staging` (or `prod`) and `P=we360-agents-$ENV`. Region `ap-south-1`.

| Role | Used by | RLS | Password lives in |
|---|---|---|---|
| `we360_owner` (RDS master, `rds_superuser`) | migrations, this runbook | n/a | RDS-managed secret (rotated by RDS every 7 days); Terraform output `db_master_secret_arn` |
| `we360_app` | API tenant requests, worker (`appDb()`) | **enforced** (`NOBYPASSRLS`) | inside `we360-agents/$ENV/DATABASE_URL` |
| `we360_admin` | super admin API, retention job (`adminDb()`) | bypassed (`BYPASSRLS`) | inside `we360-agents/$ENV/DATABASE_URL_ADMIN` |

No bastion host exists. DB access goes through the **dbadmin** one-off ECS task (`postgres:16-alpine`, master credentials injected, ECS Exec enabled).

## Open a psql session

```bash
NET=$(aws ecs describe-services --cluster $P --services $P-worker --query 'services[0].networkConfiguration' --output json)
TASK=$(aws ecs run-task --cluster $P --launch-type FARGATE --task-definition $P-dbadmin \
  --enable-execute-command --network-configuration "$NET" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-running --cluster $P --tasks $TASK
# Wait ~30 s more for the SSM agent, then:
aws ecs execute-command --cluster $P --task $TASK --container psql --interactive --command "psql"
```

Needs the Session Manager plugin for the AWS CLI locally. The task stops by itself after 1 hour; stop it sooner with `aws ecs stop-task --cluster $P --task $TASK`.

## One-time: create the app roles (before the first migration)

Migration `0001` grants `EXECUTE` to `we360_app`, so the roles must exist first. `CREATE EXTENSION vector` / `pg_trgm` run in migration `0000` as the master user, which has `rds_superuser`. That is enough on RDS.

1. Generate two passwords. Use hex, so they are URL-safe:
   ```bash
   openssl rand -hex 32   # app
   openssl rand -hex 32   # admin
   ```
2. Store the connection strings. The host is Terraform output `db_address`:
   ```bash
   aws secretsmanager put-secret-value --secret-id we360-agents/$ENV/DATABASE_URL \
     --secret-string "postgres://we360_app:<APP_PW>@<db_address>:5432/we360_agents?sslmode=verify-full"
   aws secretsmanager put-secret-value --secret-id we360-agents/$ENV/DATABASE_URL_ADMIN \
     --secret-string "postgres://we360_admin:<ADMIN_PW>@<db_address>:5432/we360_agents?sslmode=verify-full"
   ```
   About `sslmode`: RDS forces TLS. node-postgres treats `require` as full certificate verification, and Node does not trust the RDS CA by default. Use `no-verify` (still encrypted) until the API image ships the RDS CA bundle. Then switch to `verify-full`.
3. In the psql session, run this. It adapts `infra/docker/postgres-init.sql`, with the owner now being the RDS master user `we360_owner`:
   ```sql
   CREATE ROLE we360_app   LOGIN PASSWORD '<APP_PW>'   NOBYPASSRLS;
   CREATE ROLE we360_admin LOGIN PASSWORD '<ADMIN_PW>' BYPASSRLS;

   GRANT CONNECT ON DATABASE we360_agents TO we360_app, we360_admin;
   GRANT USAGE ON SCHEMA public TO we360_app, we360_admin;

   -- Tables/sequences created later by the migration owner are usable by both roles.
   ALTER DEFAULT PRIVILEGES FOR ROLE we360_owner IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO we360_app, we360_admin;
   ALTER DEFAULT PRIVILEGES FOR ROLE we360_owner IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO we360_app, we360_admin;

   -- Check: rolbypassrls must be f for we360_app and t for we360_admin.
   SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'we360_%';
   ```
   Never grant `rds_superuser` to `we360_app` or `we360_admin`. If `BYPASSRLS` is rejected, check that you are connected as the master user (`SELECT current_user;`).
4. If migrations already ran before the roles existed, also grant on existing objects:
   ```sql
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO we360_app, we360_admin;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO we360_app, we360_admin;
   GRANT EXECUTE ON FUNCTION resolve_api_key(text), resolve_deployment(text) TO we360_app;
   ```

### Rotating an app role password
Run `ALTER ROLE we360_app PASSWORD '<new>';`, then update the `DATABASE_URL` secret, then `aws ecs update-service --cluster $P --service $P-api --force-new-deployment` (repeat for worker). Expect a short burst of auth errors between the steps, so pick a quiet window.

## Migrations

- These run automatically in every deploy, **before** the services update. If a migration fails, the deploy stops and the old version keeps running.
- Task family `$P-migrate`: the API image runs `node dist/scripts/migrate.js` with `MIGRATIONS_DIR=./migrations`. `DATABASE_URL_OWNER` is built at task start from the RDS master secret, so RDS password rotation never breaks it.
- Run by hand:
  ```bash
  NET=$(aws ecs describe-services --cluster $P --services $P-worker --query 'services[0].networkConfiguration' --output json)
  aws ecs run-task --cluster $P --launch-type FARGATE --task-definition $P-migrate --network-configuration "$NET"
  ```
  Logs: CloudWatch group `/ecs/$P-migrate`.
- **Seed** (plans, model catalog, feature flags): run a one-off task with the API image and command `node dist/scripts/seed.js` (needs `DATABASE_URL_OWNER`). It is insert-only: it adds missing plans/models/flags and never overwrites values edited in the super admin, so it is safe to re-run.
- Migrations must be backward compatible (expand, then contract), because old tasks keep running on the new schema during a rolling deploy or a rollback.

## Backups, restore and the PITR drill

- Automated backups: 7 days (staging), 14 days (prod), plus point-in-time recovery (PITR) to any second in that window. Prod has deletion protection, and a final snapshot is taken on delete.
- Before a risky migration, take a manual snapshot: `aws rds create-db-snapshot --db-instance-identifier $P --db-snapshot-identifier $P-pre-<change>`.

### Drill (once before launch, then quarterly; record how long each step takes)

1. Restore to a **new** instance. Never restore over the live one:
   ```bash
   aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier $P \
     --target-db-instance-identifier $P-restore --restore-time 2026-11-10T06:00:00Z \
     --db-subnet-group-name $P --vpc-security-group-ids <db sg id> \
     --db-parameter-group-name <pg16 parameter group> --no-multi-az --no-publicly-accessible
   # from a snapshot instead: aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier ...
   aws rds wait db-instance-available --db-instance-identifier $P-restore
   ```
2. Check the restore. Start the dbadmin task with an override that sets `PGHOST` to the restored endpoint (`--overrides '{"containerOverrides":[{"name":"psql","environment":[{"name":"PGHOST","value":"<restore endpoint>"}]}]}'`). Then run `SELECT count(*) FROM organization; SELECT max(created_at) FROM executions;` and confirm RLS policies exist (`\d+ agents`).
3. **Real recovery only:** move the app to the restored data. Either:
   - (a) swap instance identifiers so the endpoint stays the same: rename `$P` to `$P-old`, then `$P-restore` to `$P`, each with `aws rds modify-db-instance --new-db-instance-identifier ... --apply-immediately`; or
   - (b) put the new host into `DATABASE_URL`/`DATABASE_URL_ADMIN`.

   Then force new deployments of api and worker, and reconcile the Terraform state (`terraform plan`) before the next apply.
4. Drill only: `aws rds delete-db-instance --db-instance-identifier $P-restore --skip-final-snapshot`.

Targets: RPO ≤ 5 minutes (PITR), RTO ≤ 1 hour.

### Privacy: re-apply deletions after a real restore

A restore brings back anything deleted after the restore point, including data people asked us to erase. Before reopening traffic, re-apply every deletion recorded in the **live** database's audit log since the restore time (run as `we360_admin` on the restored instance):

```sql
-- End-user erasures (the audit log stores a 12-character SHA-256 fingerprint of the user id, never the id itself).
DELETE FROM executions e USING conversations c
 WHERE e.conversation_id = c.id AND (c.org_id, left(encode(sha256(convert_to(c.end_user_ref, 'UTF8')), 'hex'), 12)) IN (<org_id, target_id pairs for action 'privacy.end_user_erased'>);
DELETE FROM conversations c
 WHERE (c.org_id, left(encode(sha256(convert_to(c.end_user_ref, 'UTF8')), 'hex'), 12)) IN (<same pairs>);
-- Single conversations ('conversation.deleted'), deleted accounts ('user.deleted') and organizations: delete by target_id.
```

Then run the `retention` and `purge-deleted` maintenance jobs once. Deleted data disappears from backups on its own after the backup window (14 days in prod); S3 keeps old file versions for 30 days.
