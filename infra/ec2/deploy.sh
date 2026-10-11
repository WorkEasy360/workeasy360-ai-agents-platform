#!/usr/bin/env bash
# Deploys one image tag on this instance. Run by GitHub Actions through AWS SSM (as root):
#   deploy.sh <image-tag> <ecr-registry> <secret-id> <aws-region> <domain>
#
# 1. Reads all configuration from one Secrets Manager secret (a JSON object of env vars).
# 2. Pulls the api/web images from ECR.
# 3. Prepares the database (db-init), runs migrations and the catalog seed with the owner connection.
#    If any of these fail, the running version is left untouched.
# 4. Restarts the stack and waits for health checks. If the new version is unhealthy, it goes back to
#    the previous tag. Migrations are not reversed, so they must stay compatible with the previous version.
set -euo pipefail

TAG="${1:?image tag}"; REGISTRY="${2:?registry}"; SECRET_ID="${3:?secret id}"; REGION="${4:?region}"; DOMAIN="${5:?domain}"
DIR=/opt/we360
cd "$DIR"
umask 077

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

log "Reading configuration from Secrets Manager ($SECRET_ID)"
aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text > secret.json.tmp
jq -e 'type == "object"' secret.json.tmp > /dev/null || { echo "Secret $SECRET_ID must be a JSON object"; exit 1; }
for key in DATABASE_URL DATABASE_URL_ADMIN DATABASE_URL_OWNER BETTER_AUTH_SECRET API_KEY_PEPPER KMS_KEY_ID S3_BUCKET; do
  jq -e --arg k "$key" '.[$k] | type == "string" and length > 0' secret.json.tmp > /dev/null || { echo "Secret is missing $key"; exit 1; }
done
if jq -e '[.[] | tostring | test("\n")] | any' secret.json.tmp > /dev/null; then echo "Secret values must not contain newlines"; exit 1; fi

# Long-running services: everything except the owner connection. APP_URL and AWS_REGION default from the deploy.
jq -r --arg url "https://$DOMAIN" --arg region "$REGION" \
  '{APP_URL: $url, AWS_REGION: $region} + . | del(.DATABASE_URL_OWNER) | to_entries[] | "\(.key)=\(.value)"' \
  secret.json.tmp > app.env
# One-off database tasks only.
jq -r '{NODE_ENV: "production"} + {DATABASE_URL_OWNER, DATABASE_URL, DATABASE_URL_ADMIN} | to_entries[] | "\(.key)=\(.value)"' \
  secret.json.tmp > owner.env
rm -f secret.json.tmp

PREVIOUS="$(cat current-tag 2>/dev/null || true)"
write_compose_env() { printf 'REGISTRY=%s\nIMAGE_TAG=%s\nDOMAIN=%s\n' "$REGISTRY" "$1" "$DOMAIN" > .env; }
write_compose_env "$TAG"

log "Pulling images for $TAG"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" > /dev/null
docker compose pull --quiet api web
docker compose --profile tasks pull --quiet dbtask

log "Preparing database"
docker compose run --rm --no-deps dbtask node dist/scripts/db-init.js
log "Running migrations"
docker compose run --rm --no-deps dbtask node dist/scripts/migrate.js
log "Seeding plans and model catalog"
docker compose run --rm --no-deps dbtask node dist/scripts/seed.js

log "Starting $TAG"
if docker compose up -d --remove-orphans --wait --wait-timeout 180; then
  echo "$TAG" > current-tag
  log "Healthy"
else
  log "New version is unhealthy. Recent logs:"
  docker compose logs --tail 80 api web worker || true
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TAG" ]; then
    log "Rolling back to $PREVIOUS"
    write_compose_env "$PREVIOUS"
    docker compose up -d --remove-orphans --wait --wait-timeout 180 || log "Rollback is unhealthy too"
  fi
  exit 1
fi

# Keep the current and previous images (for rollback); remove older ones.
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep -E '/we360-agents-(api|web):' \
  | grep -vE ":(${TAG}|${PREVIOUS:-none})$" \
  | xargs -r docker rmi > /dev/null 2>&1 || true
docker image prune -f > /dev/null
log "Deployed $TAG"
