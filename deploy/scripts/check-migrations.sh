#!/usr/bin/env bash
# Refuses migrations that would reach outside the app's own schema (`agents`) in the shared Aurora
# database: a hardcoded schema (public, drizzle, helpdesk, hrms), CREATE EXTENSION, search_path changes,
# role/database-level DDL, grants/revokes, or dropping schemas. Runs in CI and before every deploy's
# migrate step.
#
#   bash deploy/scripts/check-migrations.sh [path/to/migrations]
#
# Allowed on purpose: `SET search_path FROM CURRENT` on our own SECURITY DEFINER functions (it pins them
# to the migration's own search_path) and `TO public` in CREATE POLICY (the PUBLIC pseudo-role, not a schema).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="${1:-$here/../../packages/db/migrations}"

if [ ! -d "$dir" ]; then
  echo "check-migrations: no migrations directory at $dir" >&2
  exit 1
fi

pattern='"(public|drizzle|helpdesk|hrms)"[[:space:]]*\.|\b(public|drizzle|helpdesk|hrms)\.|CREATE[[:space:]]+EXTENSION|search_path[[:space:]]*(=|TO\b)|set_config[[:space:]]*\([[:space:]]*'"'"'search_path|ALTER[[:space:]]+(DATABASE|ROLE|USER|SYSTEM|SCHEMA|EXTENSION|DEFAULT[[:space:]]+PRIVILEGES)|CREATE[[:space:]]+(ROLE|USER|DATABASE|SCHEMA)|DROP[[:space:]]+(SCHEMA|DATABASE|ROLE|USER|OWNED|EXTENSION)|\bGRANT[[:space:]]|\bREVOKE[[:space:]]|SET[[:space:]]+(LOCAL[[:space:]]+)?ROLE|SET[[:space:]]+SESSION[[:space:]]+AUTHORIZATION'

if matches="$(grep -rniE "$pattern" --include='*.sql' "$dir")"; then
  echo "check-migrations: FAILED. These statements would touch objects outside schema agents:" >&2
  echo "$matches" >&2
  echo "Fix the migration: unqualified names resolve to the app's own schema (pnpm --filter @we360/db generate strips \"public\".)." >&2
  exit 1
fi

count="$(find "$dir" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
echo "check-migrations: OK ($count migrations, nothing outside the app's schema)"
