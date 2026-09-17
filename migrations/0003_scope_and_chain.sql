-- 0003_scope_creation_and_chain.sql
--
-- Two additions, both closing gaps that only show up under adversarial use:
--
--  1. `scopes` deliberately has no RLS policy, because creating an ownership
--     boundary is a privileged act. That means scope creation must go through an
--     explicitly privileged, idempotent function rather than an INSERT the
--     application role cannot legally perform.
--
--  2. The first version of the chain stored only `prev_hash`. That detects a
--     reordering but not a wholesale rewrite: anyone able to UPDATE the ledger
--     could recompute every `prev_hash` consistently. `link_hash` commits to the
--     event's own identity and content as well, so a rewrite has to forge every
--     link rather than patch one.

-- ---------------------------------------------------------------------------
-- Scope construction
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.ensure_scope(
  p_tenant  UUID,
  p_project TEXT,
  p_user    TEXT,
  p_agent   TEXT,
  p_session TEXT,
  p_purpose TEXT[]
) RETURNS TABLE (
  scope_id UUID, tenant_id UUID, project TEXT,
  user_id TEXT, agent_id TEXT, session_id TEXT, purpose TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_scope_id UUID;
  v_purpose  TEXT[];
BEGIN
  IF p_project IS NULL AND p_user IS NULL AND p_agent IS NULL AND p_session IS NULL THEN
    RAISE EXCEPTION 'a scope must bind at least one of project, user, agent or session'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Purposes are sorted and de-duplicated so that two writes differing only in
  -- purpose order resolve to the same scope instead of fragmenting the boundary.
  SELECT COALESCE(array_agg(DISTINCT p ORDER BY p), ARRAY[]::text[])
    INTO v_purpose
    FROM unnest(COALESCE(p_purpose, ARRAY[]::text[])) AS p;

  SELECT s.scope_id INTO v_scope_id
    FROM scopes s
   WHERE s.tenant_id = p_tenant
     AND s.project    IS NOT DISTINCT FROM p_project
     AND s.user_id    IS NOT DISTINCT FROM p_user
     AND s.agent_id   IS NOT DISTINCT FROM p_agent
     AND s.session_id IS NOT DISTINCT FROM p_session
     AND s.purpose = v_purpose
   LIMIT 1;

  IF v_scope_id IS NULL THEN
    INSERT INTO scopes (scope_id, tenant_id, project, user_id, agent_id, session_id, purpose)
    VALUES (gen_random_uuid(), p_tenant, p_project, p_user, p_agent, p_session, v_purpose)
    ON CONFLICT DO NOTHING
    RETURNING scopes.scope_id INTO v_scope_id;

    IF v_scope_id IS NULL THEN
      -- Lost a concurrent creation race; adopt the winner's row.
      SELECT s.scope_id INTO v_scope_id
        FROM scopes s
       WHERE s.tenant_id = p_tenant
         AND s.project    IS NOT DISTINCT FROM p_project
         AND s.user_id    IS NOT DISTINCT FROM p_user
         AND s.agent_id   IS NOT DISTINCT FROM p_agent
         AND s.session_id IS NOT DISTINCT FROM p_session
         AND s.purpose = v_purpose
       LIMIT 1;
    END IF;
  END IF;

  RETURN QUERY
    SELECT s.scope_id, s.tenant_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
      FROM scopes s WHERE s.scope_id = v_scope_id;
END;
$$;

-- Scope creation is the one place the application may cross a tenant boundary in
-- the schema, and only into a tenant it already holds the id for.
GRANT EXECUTE ON FUNCTION veritymem.ensure_scope(UUID, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO veritymem_app;

-- ---------------------------------------------------------------------------
-- Ledger chain
-- ---------------------------------------------------------------------------

ALTER TABLE events ADD COLUMN link_hash BYTEA;

COMMENT ON COLUMN events.link_hash IS
  'SHA-256 over (stream_id, seq, content_hash, prev_hash, actor_id, occurred_at). Commits to the event identity as well as its position, so a chain rewrite must forge every link.';

CREATE INDEX events_link_hash_idx ON events (tenant_id, stream_id, seq) WHERE link_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tenant administration
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.ensure_tenant(p_tenant UUID, p_slug TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO tenants (tenant_id, slug, name)
  VALUES (p_tenant, p_slug, p_slug)
  ON CONFLICT (tenant_id) DO NOTHING
$$;

GRANT EXECUTE ON FUNCTION veritymem.ensure_tenant(UUID, TEXT) TO veritymem_app;
