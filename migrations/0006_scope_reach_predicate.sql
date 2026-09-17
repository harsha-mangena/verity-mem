-- 0006_scope_reach_predicate.sql
--
-- Replaces two OR'd policies with one predicate that is a single source of truth.
--
-- The previous shape was:
--
--     events_tenant  USING (tenant_id = current_tenant_id())
--     events_scope   USING (scope_authorized(scope_id, scope_id, current_purposes()))
--
-- Permissive policies are combined with OR, so a row was visible when *either*
-- held. The scope clause alone never checked that the caller's tenant matched the
-- row's tenant; it trusted the caller's bound scope-id array. That is only sound
-- if the bound array is itself trustworthy, and nothing verified it. Two
-- consequences, one benign and one not:
--
--   * rows from a second tenant whose scope the caller happened to name were
--     admitted by the scope clause while being rejected by the tenant clause, so
--     the effective boundary was the *cheaper* of two clauses rather than both;
--   * an empty or unbound scope array was not a systematic deny inside the scope
--     clause, which is precisely the kind of near-miss that becomes a leak after
--     one refactor.
--
-- The corrected predicate answers one question per row:
--
--     does this row's scope lie inside any scope the caller holds,
--     in the caller's own tenant, for a declared purpose?
--
-- Three clauses, all of which must hold, expressed once and reused by every
-- scoped table. `COALESCE(..., FALSE)` is deliberate: a policy expression that
-- evaluates to NULL is treated as a pass in PostgreSQL, so an accidental NULL is
-- an authorization bypass. Returning an explicit boolean removes that class of
-- bug rather than relying on nobody ever introducing one.

-- ---------------------------------------------------------------------------
-- Caller scopes, resolved once per transaction
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.caller_scopes() RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'scope_id', s.scope_id,
              'tenant_id', s.tenant_id,
              'project',   s.project,
              'user_id',   s.user_id,
              'agent_id',  s.agent_id,
              'session_id', s.session_id,
              'purpose',   to_jsonb(s.purpose)))
       FROM scopes s
      WHERE s.scope_id = ANY(veritymem.current_scope_ids())),
    '[]'::jsonb
  )
$$;

-- ---------------------------------------------------------------------------
-- The predicate
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.scope_reachable(p_scope UUID, p_purposes TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_row_tenant   UUID;
  v_row_project  TEXT;
  v_row_user     TEXT;
  v_row_agent    TEXT;
  v_row_session  TEXT;
  v_row_purpose  TEXT[];
  v_caller       JSONB;
BEGIN
  -- Clause 1: the caller must declare at least one purpose. An empty purpose set
  -- is not a wildcard, it is the absence of an authorization basis.
  IF p_purposes IS NULL OR COALESCE(array_length(p_purposes, 1), 0) = 0 THEN
    RETURN FALSE;
  END IF;
  IF p_scope IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Clause 2: the row's scope must exist and must itself name a purpose that the
  -- caller declared. This is the clause that makes an empty-purpose scope
  -- unreachable rather than universal.
  SELECT r.tenant_id, r.project, r.user_id, r.agent_id, r.session_id, r.purpose
    INTO v_row_tenant, v_row_project, v_row_user, v_row_agent, v_row_session, v_row_purpose
    FROM scopes r
   WHERE r.scope_id = p_scope;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF COALESCE(array_length(v_row_purpose, 1), 0) = 0 THEN
    RETURN FALSE;
  END IF;
  IF NOT (v_row_purpose && p_purposes) THEN
    RETURN FALSE;
  END IF;

  -- Clause 3: some scope the caller holds must contain the row's scope, and must
  -- be in the same tenant. Same tenant is checked here rather than in a sibling
  -- policy so that it cannot be lost to OR-combination or to a future
  -- RESTRICTIVE/PERMISSIVE change.
  SELECT c.value
    INTO v_caller
    FROM jsonb_array_elements(veritymem.caller_scopes()) AS c(value)
   WHERE (c.value ->> 'tenant_id')::uuid = v_row_tenant
     AND ((c.value ->> 'project')    IS NULL OR v_row_project IS NULL
          OR (c.value ->> 'project')    = v_row_project)
     AND ((c.value ->> 'user_id')    IS NULL OR v_row_user    IS NULL
          OR (c.value ->> 'user_id')    = v_row_user)
     AND ((c.value ->> 'agent_id')   IS NULL OR v_row_agent   IS NULL
          OR (c.value ->> 'agent_id')   = v_row_agent)
     AND ((c.value ->> 'session_id') IS NULL OR v_row_session IS NULL
          OR (c.value ->> 'session_id') = v_row_session)
   LIMIT 1;

  RETURN v_caller IS NOT NULL;
END;
$$;

/**
 * The single authorization predicate, used by every scoped table's policy.
 * Fails closed: no bound scopes, no purposes, or no tenant match returns FALSE.
 */
CREATE OR REPLACE FUNCTION veritymem.row_authorized(p_tenant UUID, p_scope UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    p_tenant IS NOT NULL
    AND p_tenant = veritymem.current_tenant_id()
    AND veritymem.scope_reachable(p_scope, veritymem.current_purposes()),
    FALSE
  )
$$;

-- ---------------------------------------------------------------------------
-- Policy replacement
-- ---------------------------------------------------------------------------

-- events
DROP POLICY IF EXISTS events_tenant ON events;
DROP POLICY IF EXISTS events_scope ON events;
CREATE POLICY events_authorized ON events
  USING (veritymem.row_authorized(tenant_id, scope_id))
  WITH CHECK (veritymem.row_authorized(tenant_id, scope_id));

-- claims
DROP POLICY IF EXISTS claims_tenant ON claims;
DROP POLICY IF EXISTS claims_scope ON claims;
CREATE POLICY claims_authorized ON claims
  USING (veritymem.row_authorized(tenant_id, scope_id))
  WITH CHECK (veritymem.row_authorized(tenant_id, scope_id));

-- claim_candidates
DROP POLICY IF EXISTS candidates_tenant ON claim_candidates;
DROP POLICY IF EXISTS candidates_scope ON claim_candidates;
CREATE POLICY candidates_authorized ON claim_candidates
  USING (veritymem.row_authorized(tenant_id, requested_scope))
  WITH CHECK (veritymem.row_authorized(tenant_id, requested_scope));

-- claim_embeddings
DROP POLICY IF EXISTS embeddings_tenant ON claim_embeddings;
DROP POLICY IF EXISTS embeddings_reachable ON claim_embeddings;
CREATE POLICY embeddings_authorized ON claim_embeddings
  USING (
    EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = claim_embeddings.claim_id)
  )
  WITH CHECK (
    COALESCE(claim_embeddings.tenant_id = veritymem.current_tenant_id(), FALSE)
  );

-- decisions: tenant gate plus reachability through the claim or candidate.
DROP POLICY IF EXISTS decisions_tenant ON decisions;
DROP POLICY IF EXISTS decisions_reachable ON decisions;
CREATE POLICY decisions_authorized ON decisions
  USING (
    COALESCE(decisions.tenant_id = veritymem.current_tenant_id(), FALSE)
    AND (
      (claim_id IS NOT NULL AND EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = decisions.claim_id))
      OR (candidate_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM claim_candidates cc WHERE cc.candidate_id = decisions.candidate_id))
    )
  )
  WITH CHECK (COALESCE(decisions.tenant_id = veritymem.current_tenant_id(), FALSE));

-- grants, traces, retention jobs are tenant-scoped only, but still fail closed.
DROP POLICY IF EXISTS grants_tenant ON grants;
CREATE POLICY grants_authorized ON grants
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE));

DROP POLICY IF EXISTS traces_tenant ON query_traces;
CREATE POLICY traces_authorized ON query_traces
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE));

DROP POLICY IF EXISTS retention_tenant ON retention_jobs;
CREATE POLICY retention_authorized ON retention_jobs
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE));

-- ---------------------------------------------------------------------------
-- Self-check
--
-- A migration that replaces an authorization predicate must demonstrate the
-- predicate still denies. These assertions run in the same transaction as the
-- change, so a regression aborts the migration rather than shipping.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_scope  UUID;
  v_tenant UUID;
  v_other  UUID;
  v_purpose TEXT[];
BEGIN
  SELECT s.scope_id, s.tenant_id, s.purpose
    INTO v_scope, v_tenant, v_purpose
    FROM scopes s WHERE COALESCE(array_length(s.purpose, 1), 0) > 0 LIMIT 1;
  IF v_scope IS NULL THEN
    RETURN;
  END IF;

  -- No context at all: everything denies.
  IF veritymem.row_authorized(v_tenant, v_scope) THEN
    RAISE EXCEPTION 'self-check failed: authorized with no request context bound';
  END IF;

  PERFORM veritymem.set_request_context(v_tenant, 'self-check', ARRAY[v_scope], v_purpose, 'verify');
  IF NOT veritymem.row_authorized(v_tenant, v_scope) THEN
    RAISE EXCEPTION 'self-check failed: a scope no longer reaches itself';
  END IF;

  -- Wrong tenant, correct scope id: denies.
  SELECT s.tenant_id INTO v_other FROM scopes s WHERE s.tenant_id <> v_tenant LIMIT 1;
  IF v_other IS NOT NULL AND veritymem.row_authorized(v_other, v_scope) THEN
    RAISE EXCEPTION 'self-check failed: a foreign tenant was authorized';
  END IF;

  -- Empty purposes: denies even for the caller''s own scope.
  PERFORM veritymem.set_request_context(v_tenant, 'self-check', ARRAY[v_scope], ARRAY[]::text[], 'verify');
  IF veritymem.row_authorized(v_tenant, v_scope) THEN
    RAISE EXCEPTION 'self-check failed: authorized with an empty purpose set';
  END IF;

  -- Unknown scope: denies.
  PERFORM veritymem.set_request_context(v_tenant, 'self-check', ARRAY[v_scope], v_purpose, 'verify');
  IF veritymem.row_authorized(v_tenant, gen_random_uuid()) THEN
    RAISE EXCEPTION 'self-check failed: an unknown scope was authorized';
  END IF;

  -- Reset so the migration leaves no context behind.
  PERFORM set_config('veritymem.tenant_id', '', true);
  PERFORM set_config('veritymem.scope_ids', '', true);
  PERFORM set_config('veritymem.purposes', '', true);
END
$$;

GRANT EXECUTE ON FUNCTION veritymem.caller_scopes() TO veritymem_app;
GRANT EXECUTE ON FUNCTION veritymem.scope_reachable(UUID, TEXT[]) TO veritymem_app;
GRANT EXECUTE ON FUNCTION veritymem.row_authorized(UUID, UUID) TO veritymem_app;
