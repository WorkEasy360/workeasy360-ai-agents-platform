-- Local only. In RDS these roles are created once by ops (see docs/runbooks/database.md).
-- we360_app   : used by the API for tenant requests. Row-level security applies.
-- we360_admin : used by the worker and super admin API. Bypasses RLS; never used for tenant requests.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE ROLE we360_app LOGIN PASSWORD 'we360_app' NOBYPASSRLS;
CREATE ROLE we360_admin LOGIN PASSWORD 'we360_admin' BYPASSRLS;

GRANT CONNECT ON DATABASE we360_agents TO we360_app, we360_admin;
GRANT USAGE ON SCHEMA public TO we360_app, we360_admin;

-- Tables created later by the migration owner (postgres) are usable by both roles.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO we360_app, we360_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO we360_app, we360_admin;
