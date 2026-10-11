-- ---------------------------------------------------------------------------
-- WorkEasy360 AI Agents: own roles + own schema inside the EXISTING shared database.
--
-- Run ONCE, as the admin user, connected to the shared database. From the EC2 host
-- (psql runs in a throwaway container; the admin password is read from the prompt):
--
--   read -rs PGPASSWORD && export PGPASSWORD
--   docker run --rm -i -e PGPASSWORD -v "$PWD/sql:/sql:ro" postgres:18-alpine \
--     psql "host=<writer-endpoint> port=5432 dbname=postgres user=postgres sslmode=require" \
--          -v owner_pw="$(grep -oP '^DATABASE_URL_ADMIN=postgres://agents_owner:\K[^@]+' .env)" \
--          -v app_pw="$(grep -oP '^DATABASE_URL=postgres://agents_app:\K[^@]+' .env)" \
--          -v db=postgres -f /sql/01-create-roles-and-schema.sql
--   unset PGPASSWORD
--
-- What this creates, and nothing else:
--   * role agents_owner: owns schema `agents` and its tables; runs migrations and the worker.
--     Row-level security does not apply to the table owner, so the worker sees all tenants.
--   * role agents_app: used by the API. Only SELECT/INSERT/UPDATE/DELETE on agents' tables,
--     and row-level security applies, so each request sees only its own organization.
--   * schema agents.
--   * extension vector (pgvector) INSIDE schema agents, only if the database has no pgvector yet.
--     This is the one agreed exception to "no CREATE EXTENSION". If another schema already has it,
--     nothing is created and the roles' search_path includes that schema (read-only use).
-- Neither role is superuser, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION.
-- It does not alter, grant on or revoke from any existing object, role or schema.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- 1. Roles. Passwords come in through -v, so they never land in a file. Connection limits total 20
--    (API pool 8 + worker/admin pool 5 + the one-off migrate job + headroom).
CREATE ROLE agents_owner LOGIN PASSWORD :'owner_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
CREATE ROLE agents_app LOGIN PASSWORD :'app_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12;

-- 2. The schema, owned by agents_owner. PostgreSQL 16+ only lets the creator hand ownership to a role
--    it may SET ROLE to, so that is granted for these statements and withdrawn at the end.
GRANT agents_owner TO CURRENT_USER WITH SET TRUE;
CREATE SCHEMA agents AUTHORIZATION agents_owner;

-- 3. pgvector: create it inside `agents` unless the database already has it somewhere.
SELECT coalesce((SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
                 WHERE e.extname = 'vector'), '') AS vector_schema \gset
SELECT :'vector_schema' = '' AS create_vector \gset
\if :create_vector
  CREATE EXTENSION vector SCHEMA agents;
  \set search_path 'agents, pg_temp'
\else
  \echo 'pgvector already installed in schema' :vector_schema '- not creating it'
  SELECT format('agents, %I, pg_temp', :'vector_schema') AS search_path \gset
\endif

-- 4. What agents_app may do inside agents (set as the owner, so it covers tables the migrations create).
SET ROLE agents_owner;
GRANT USAGE ON SCHEMA agents TO agents_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agents GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agents_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agents GRANT USAGE, SELECT ON SEQUENCES TO agents_app;
RESET ROLE;
GRANT agents_owner TO CURRENT_USER WITH SET FALSE;

-- 5. Unqualified names resolve to agents (pg_temp last, so temporary objects can't shadow tables).
ALTER ROLE agents_owner SET search_path = :search_path;
ALTER ROLE agents_app SET search_path = :search_path;

-- 6. Let the roles connect (explicit in case PUBLIC's CONNECT was revoked by the DBA).
GRANT CONNECT ON DATABASE :"db" TO agents_owner, agents_app;

-- Verify:
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolconnlimit, rolconfig
  FROM pg_roles WHERE rolname LIKE 'agents\_%' ORDER BY 1;
SELECT e.extname, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector';

-- ---------------------------------------------------------------------------
-- Deliberately NOT done here:
--  * REVOKE ... FROM PUBLIC on any schema or database.
--  * Any statement on schemas public, helpdesk or hrms.
-- ---------------------------------------------------------------------------
