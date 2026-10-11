-- ---------------------------------------------------------------------------
-- Proves what an app role can reach in the shared database. Read-only. Run it as agents_app and as
-- agents_owner (their own logins, not the admin) after the setup and whenever in doubt. From
-- ~/agents/deploy on the server (rds-ca.pem: the AWS RDS CA bundle, see deploy/README.md):
--
--   for v in DATABASE_URL DATABASE_URL_ADMIN; do
--     docker run --rm -i -v "$PWD/rds-ca.pem:/ca.pem:ro" postgres:18-alpine \
--       psql "$(grep "^$v=" .env | cut -d= -f2-)&sslrootcert=/ca.pem" -At < sql/02-verify-isolation.sql
--   done
--
-- Every count must be 0, except "own tables". Any "readable/writable:" line names a table to look at.
-- ---------------------------------------------------------------------------

-- Who am I, and where do unqualified names go?
SELECT 'role: ' || current_user || ', search_path: ' || current_setting('search_path') || ', current schema: ' || coalesce(current_schema(), '(none)');

-- Attributes: never superuser, never bypassing row-level security, never creating roles or databases.
SELECT 'dangerous role attributes: ' || count(*)
FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication);

-- Tables, views and sequences in OTHER schemas this role could read or change.
SELECT 'other-schema tables/views readable or writable: ' || count(*)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('agents', 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
  AND (has_table_privilege(c.oid, 'SELECT') OR has_table_privilege(c.oid, 'INSERT')
       OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE')
       OR has_table_privilege(c.oid, 'TRUNCATE'));

-- The same, listed by name (empty when isolated).
SELECT 'readable/writable: ' || n.nspname || '.' || c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('agents', 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
  AND (has_table_privilege(c.oid, 'SELECT') OR has_table_privilege(c.oid, 'INSERT')
       OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE')
       OR has_table_privilege(c.oid, 'TRUNCATE'))
ORDER BY 1;

-- Schemas other than agents where this role could create objects.
SELECT 'other schemas with CREATE: ' || count(*)
FROM pg_namespace n
WHERE n.nspname NOT IN ('agents', 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
  AND has_schema_privilege(n.oid, 'CREATE');

-- Can it create schemas in the database (it must not).
SELECT 'CREATE on the database: ' || has_database_privilege(current_database(), 'CREATE')::int;

-- What it owns: only schema agents and objects inside it.
SELECT 'objects owned outside schema agents: ' || count(*)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND n.nspname <> 'agents'
  AND n.nspname NOT LIKE 'pg_toast%'; -- internal storage of the role's own large values

SELECT 'own tables (schema agents, visible to this role): ' || count(*)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'agents' AND c.relkind IN ('r', 'p') AND has_table_privilege(c.oid, 'SELECT');
