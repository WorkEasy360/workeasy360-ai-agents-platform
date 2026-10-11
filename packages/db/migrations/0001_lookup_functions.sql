-- Narrow lookups that must run before the tenant is known (API key auth, public deployments).
-- SECURITY DEFINER runs as the owner (bypassing RLS) but each function only returns the
-- single matching row's routing fields, never arbitrary tenant data.

CREATE OR REPLACE FUNCTION resolve_api_key(p_hash text)
RETURNS TABLE (id uuid, org_id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT k.id, k.org_id, k.workspace_id
  FROM api_keys k
  WHERE k.key_hash = p_hash
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now())
  LIMIT 1
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION resolve_deployment(p_public_key text)
RETURNS TABLE (id uuid, org_id uuid, workspace_id uuid, agent_id uuid, channel text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.org_id, d.workspace_id, d.agent_id, d.channel, d.status
  FROM deployments d
  WHERE d.public_key = p_public_key AND d.deleted_at IS NULL
  LIMIT 1
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_deployment(text) FROM PUBLIC;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'we360_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO we360_app;
    GRANT EXECUTE ON FUNCTION resolve_deployment(text) TO we360_app;
  END IF;
END $$;
