-- 0005_purpose_predicate_fix.sql
--
-- Closes an authorization hole found by the ledger test suite.
--
-- The original containment predicate treated an empty `purpose` array on a row
-- as "unrestricted":
--
--     COALESCE(array_length(r.purpose, 1), 0) = 0 OR ...
--
-- and it also treated an empty caller purpose set as "unqualified". Those two
-- conveniences composed into a genuine hole: a caller with no scopes bound at all
-- satisfied `c.scope_id = p_caller` whenever the row's scope id happened to equal
-- the caller's, and a row whose purpose array was empty matched unconditionally.
-- The practical effect was that events recorded with no purpose were readable
-- outside any purpose boundary, and the deny-by-default behaviour of row-level
-- security could be defeated for those rows.
--
-- The corrected rule has no wildcard for an absent purpose:
--
--   * a row's scope must name at least one purpose, and
--   * the caller's purpose set must be non-empty, and
--   * the two must intersect.
--
-- The write path (`veritymem.assert_purposes`) enforces the first condition at
-- admission, so an empty-purpose scope cannot be created through the API at all.
-- Being unreachable is the correct failure mode for one that predates this fix.

CREATE OR REPLACE FUNCTION veritymem.scope_authorized(
  p_caller UUID, p_row UUID, p_purposes TEXT[]
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_row_purposes  TEXT[];
  v_row_tenant    UUID;
  v_row_project   TEXT;
  v_row_user      TEXT;
  v_row_agent     TEXT;
  v_row_session   TEXT;
  v_caller_found  BOOLEAN;
BEGIN
  -- An empty purpose set is not a wildcard. It is the absence of an
  -- authorization basis, and it denies.
  IF p_purposes IS NULL OR COALESCE(array_length(p_purposes, 1), 0) = 0 THEN
    RETURN FALSE;
  END IF;
  IF p_caller IS NULL OR p_row IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT r.tenant_id, r.project, r.user_id, r.agent_id, r.session_id, r.purpose
    INTO v_row_tenant, v_row_project, v_row_user, v_row_agent, v_row_session, v_row_purposes
    FROM scopes r
   WHERE r.scope_id = p_row;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF COALESCE(array_length(v_row_purposes, 1), 0) = 0 THEN
    RETURN FALSE;
  END IF;
  IF NOT (v_row_purposes && p_purposes) THEN
    RETURN FALSE;
  END IF;

  SELECT TRUE
    INTO v_caller_found
    FROM scopes c
   WHERE c.scope_id = p_caller
     AND c.tenant_id = v_row_tenant
     -- A NULL dimension on the caller's scope means "any value" for that
     -- dimension; the row is reached. A non-NULL caller dimension must match, and
     -- a dimension the row names but the caller does not is deliberately not a
     -- barrier: a project-scoped caller reaches every user in that project. That
     -- is the containment boundary, and per-user isolation is the query
     -- planner's job — see docs/threat-model.md.
     AND (c.project    IS NULL OR v_row_project IS NULL OR c.project    = v_row_project)
     AND (c.user_id    IS NULL OR v_row_user    IS NULL OR c.user_id    = v_row_user)
     AND (c.agent_id   IS NULL OR v_row_agent   IS NULL OR c.agent_id   = v_row_agent)
     AND (c.session_id IS NULL OR v_row_session IS NULL OR c.session_id = v_row_session);

  RETURN COALESCE(v_caller_found, FALSE);
END;
$$;

-- ---------------------------------------------------------------------------
-- Admission-time guard
--
-- Purpose is a first-class part of the ownership boundary, so a scope without one
-- has no boundary. Reject it where it is created rather than letting it exist and
-- relying on it being unreachable.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.assert_purposes(p_purpose TEXT[])
RETURNS VOID
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p_purpose IS NULL OR COALESCE(array_length(p_purpose, 1), 0) = 0 THEN
    RAISE EXCEPTION 'a scope must declare at least one purpose'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

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

  PERFORM veritymem.assert_purposes(p_purpose);

  SELECT COALESCE(array_agg(DISTINCT p ORDER BY p), ARRAY[]::text[])
    INTO v_purpose
    FROM unnest(p_purpose) AS p
   WHERE p IS NOT NULL AND p <> '';

  PERFORM veritymem.assert_purposes(v_purpose);

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

GRANT EXECUTE ON FUNCTION veritymem.ensure_scope(UUID, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO veritymem_app;
GRANT EXECUTE ON FUNCTION veritymem.assert_purposes(TEXT[]) TO veritymem_app;

-- ---------------------------------------------------------------------------
-- Self-check
--
-- The migration fails if the corrected predicate still admits a row to a caller
-- with no purposes. A migration that fixes an authorization bug should prove it
-- fixed it, in the same transaction that claims to.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_scope UUID;
  v_tenant UUID;
BEGIN
  SELECT s.scope_id, s.tenant_id INTO v_scope, v_tenant
    FROM scopes s WHERE COALESCE(array_length(s.purpose, 1), 0) > 0 LIMIT 1;

  IF v_scope IS NULL THEN
    RETURN;  -- nothing to check on an empty database
  END IF;

  IF veritymem.scope_authorized(v_scope, v_scope, ARRAY[]::text[]) THEN
    RAISE EXCEPTION 'purpose predicate self-check failed: empty purpose set was authorized';
  END IF;
  IF veritymem.scope_authorized(v_scope, v_scope, NULL) THEN
    RAISE EXCEPTION 'purpose predicate self-check failed: NULL purpose set was authorized';
  END IF;
  IF NOT veritymem.scope_authorized(v_scope, v_scope, (SELECT purpose FROM scopes WHERE scope_id = v_scope)) THEN
    RAISE EXCEPTION 'purpose predicate self-check failed: a scope no longer reaches itself';
  END IF;
END
$$;
