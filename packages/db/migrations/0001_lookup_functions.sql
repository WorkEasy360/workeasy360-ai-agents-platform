-- Narrow lookups that must run before the tenant is known (API key auth, public deployments).
-- SECURITY DEFINER runs as the owner (bypassing RLS) but each function only returns the
-- single matching row's routing fields, never arbitrary tenant data.
--
-- `SET search_path FROM CURRENT` pins the function to the migration's search_path (the app's own
-- schema, then pg_temp), so callers can't redirect the table names. No schema is named here: the
-- same migration works in any schema. Only roles with USAGE on the app's schema can call these.

CREATE OR REPLACE FUNCTION resolve_api_key(p_hash text)
RETURNS TABLE (id uuid, org_id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT k.id, k.org_id, k.workspace_id
  FROM api_keys k
  WHERE k.key_hash = p_hash
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now())
  LIMIT 1
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION resolve_deployment(p_public_key text)
RETURNS TABLE (id uuid, org_id uuid, workspace_id uuid, agent_id uuid, channel text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT d.id, d.org_id, d.workspace_id, d.agent_id, d.channel, d.status
  FROM deployments d
  WHERE d.public_key = p_public_key AND d.deleted_at IS NULL
  LIMIT 1
$$;
