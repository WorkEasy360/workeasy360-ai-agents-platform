#!/usr/bin/env bash
# Pull, migrate, and (re)start the production stack. Run on the host:
#
#   PULL=1 IMAGE_PREFIX=ghcr.io/<owner>/agents IMAGE_TAG=<sha> bash deploy/scripts/deploy.sh
#   SKIP_MIGRATE=1 ... bash deploy/scripts/deploy.sh      # code-only release
#
# GitHub Actions runs this over SSH after CI passes on main (images are built on GitHub; this host never
# builds). The first time, run scripts/init-letsencrypt.sh BEFORE this.
#
# Order: preflight -> check migrations -> pull images -> table counts -> migrate (one-off step, schema
#        `agents` only) -> table counts again (other schemas must be unchanged) -> up -d -> wait for
#        health -> record the release -> prune old images.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_dir="$(cd "$here/.." && pwd)"
cd "$deploy_dir"

compose=(docker compose -f docker-compose.prod.yml)
fail() { echo "deploy: $*" >&2; exit 1; }

# --- preflight -----------------------------------------------------------------
[ -f .env ] || fail "$deploy_dir/.env is missing (cp .env.example .env, chmod 600, fill it in)"
if [ "$(stat -c %a .env)" != "600" ]; then chmod 600 .env; echo "==> .env permissions set to 600"; fi
if grep -nE '^[A-Z_]+=.*(replace-me|REPLACE_|example\.com|xxxxxxxx)' .env; then
  fail "the lines above still hold template placeholders; fill them in first"
fi
env_get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
for key in DOMAIN DATABASE_URL DATABASE_URL_ADMIN DB_SCHEMA BETTER_AUTH_SECRET API_KEY_PEPPER KMS_KEY_ID AWS_REGION S3_BUCKET; do
  [ -n "$(env_get "$key")" ] || fail "$key is empty in .env"
done
[ "$(env_get DB_SCHEMA)" = "agents" ] || fail "DB_SCHEMA must be agents (the app's own schema in the shared database)"
env_get DATABASE_URL | grep -qE '^postgres(ql)?://agents_app:' || fail "DATABASE_URL must connect as agents_app"
env_get DATABASE_URL_ADMIN | grep -qE '^postgres(ql)?://agents_owner:' || fail "DATABASE_URL_ADMIN must connect as agents_owner"
for key in DATABASE_URL DATABASE_URL_ADMIN; do
  env_get "$key" | grep -qE '[?&]sslmode=(verify-full|require)(&|$)' || fail "$key must use sslmode=verify-full (the database is in another region)"
done
if grep -qE '^DATABASE_URL[A-Z_]*=postgres(ql)?://postgres[:@]' .env; then
  fail "a DATABASE_URL uses the admin user; the app must connect as agents_app / agents_owner only"
fi
for key in MOCK_LLM LOCAL_MASTER_KEY S3_ENDPOINT ALLOW_PRIVATE_EGRESS; do
  [ -z "$(env_get "$key")" ] || [ "$(env_get "$key")" = "false" ] || fail "$key is for local development only; remove it from .env"
done
bash "$here/check-migrations.sh" "$deploy_dir/../packages/db/migrations"
"${compose[@]}" config -q

# Caller-provided values win; otherwise reuse what .env recorded for the last release.
export IMAGE_PREFIX="${IMAGE_PREFIX:-$(env_get IMAGE_PREFIX)}"
export IMAGE_TAG="${IMAGE_TAG:-$(env_get IMAGE_TAG)}"
[ -n "$IMAGE_PREFIX" ] && [ -n "$IMAGE_TAG" ] || fail "IMAGE_PREFIX and IMAGE_TAG are not set"
echo "==> Release ${IMAGE_PREFIX}-{api,web}:${IMAGE_TAG}"

# nginx can't start without a certificate; the first one comes from init-letsencrypt.sh.
domain="$(env_get DOMAIN)"
"${compose[@]}" run --rm --no-deps --entrypoint sh certbot -c "test -f /etc/letsencrypt/live/$domain/fullchain.pem" \
  || fail "no TLS certificate for $domain yet: run scripts/init-letsencrypt.sh first"

# --- images --------------------------------------------------------------------
if [ "${PULL:-0}" = "1" ]; then
  echo "==> Pulling images"
  "${compose[@]}" pull --quiet api web
else
  for img in api web; do
    docker image inspect "${IMAGE_PREFIX}-$img:${IMAGE_TAG}" >/dev/null 2>&1 \
      || fail "${IMAGE_PREFIX}-$img:${IMAGE_TAG} is not on this host (use PULL=1)"
  done
fi

# --- migrate -------------------------------------------------------------------
table_counts() { "${compose[@]}" --profile migrate run --rm --no-deps -T migrate node dist/scripts/table-counts.js; }
if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
  echo "==> Tables per schema before migrating"
  before="$(table_counts)"
  echo "$before" | sed 's/^/    /'
  echo "==> Applying migrations to schema agents (and inserting missing catalog rows)"
  "${compose[@]}" --profile migrate run --rm --no-deps migrate
  after="$(table_counts)"
  # Every schema except agents must be exactly as before.
  if [ "$(echo "$before" | grep -v '^agents ')" != "$(echo "$after" | grep -v '^agents ')" ]; then
    echo "$after" | sed 's/^/    /' >&2
    fail "table counts outside schema agents changed during the migration. Stop and investigate before going further."
  fi
  echo "==> Other schemas unchanged; agents: $(echo "$after" | grep '^agents ' | cut -d' ' -f2) tables"
else
  echo "==> SKIP_MIGRATE=1: not running migrations"
fi

# --- roll out ------------------------------------------------------------------
echo "==> Starting services"
"${compose[@]}" up -d --remove-orphans redis api worker web nginx certbot

echo "==> Waiting for api, worker and web to report healthy"
status_of() { docker inspect -f '{{.State.Health.Status}}' "$("${compose[@]}" ps -q "$1")" 2>/dev/null || echo unknown; }
for _ in $(seq 1 40); do
  api="$(status_of api)"; worker="$(status_of worker)"; web="$(status_of web)"
  [ "$api" = healthy ] && [ "$worker" = healthy ] && [ "$web" = healthy ] && break
  sleep 5
done
"${compose[@]}" ps
if [ "$api" != healthy ] || [ "$worker" != healthy ] || [ "$web" != healthy ]; then
  "${compose[@]}" logs --tail=60 api worker web >&2 || true
  fail "api is '$api', worker is '$worker', web is '$web'"
fi

# Record what is running, so a later manual `docker compose ... up -d` on this host starts the same release.
for kv in "IMAGE_TAG=${IMAGE_TAG}" "IMAGE_PREFIX=${IMAGE_PREFIX}"; do
  key="${kv%%=*}"
  if grep -qE "^$key=" .env; then sed -i "s|^$key=.*|$kv|" .env; else echo "$kv" >> .env; fi
done

# --- tidy ----------------------------------------------------------------------
# Only dangling layers; tagged images of recent releases stay for quick rollbacks.
docker image prune -f >/dev/null
echo "==> Deployed ${IMAGE_TAG}: https://${domain}"
