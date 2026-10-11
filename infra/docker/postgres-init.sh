#!/bin/sh
# Local only: runs the SAME role/schema setup as production (deploy/sql/01-create-roles-and-schema.sql)
# in the `postgres` database, with fixed local passwords. Runs once, when the Docker volume is created.
set -eu
psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -v owner_pw=agents_owner -v app_pw=agents_app -v db=postgres \
  -f /deploy-sql/01-create-roles-and-schema.sql
