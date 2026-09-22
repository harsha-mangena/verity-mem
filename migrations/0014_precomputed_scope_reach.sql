-- 0014_precomputed_scope_reach.sql
--
-- Row-level security used to recompute scope containment for every candidate row.
-- `row_authorized()` called `scope_reachable()`, which read the row scope, built a
-- JSON document for the caller's scopes, expanded it, and called `scope_contains()`.
-- PostgreSQL evaluates an RLS expression per row, so a million-row scan turned one
-- authorization decision into millions of indexed lookups and JSON expansions.
--
-- Reach depends only on the request context and the small `scopes` table. Compute it
-- once when that context is bound, store the concrete ids in a transaction-local GUC,
-- and make the hot RLS predicate an array membership check. The application still
-- proposes the held scopes; the database still validates tenant, purpose and the
-- directional containment rule before it records the reachable closure.

CREATE OR REPLACE FUNCTION veritymem.current_reachable_scope_ids() RETURNS UUID[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('veritymem.reachable_scope_ids', true), '')::uuid[],
    ARRAY[]::uuid[]
  )
$$;

CREATE OR REPLACE FUNCTION veritymem.set_request_context(
  p_tenant    UUID,
  p_principal TEXT,
  p_scope_ids UUID[],
  p_purposes  TEXT[],
  p_action    TEXT DEFAULT 'read'
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_reachable UUID[];
BEGIN
  -- Bind the tenant before reading `scopes`: that table has tenant RLS and an
  -- unbound lookup correctly sees nothing.
  PERFORM set_config('veritymem.tenant_id', p_tenant::text, true);
  PERFORM set_config('veritymem.principal_id', COALESCE(p_principal, ''), true);
  PERFORM set_config('veritymem.system', 'false', true);
  PERFORM set_config('veritymem.scope_ids', to_jsonb(COALESCE(p_scope_ids, ARRAY[]::uuid[]))::text, true);
  PERFORM set_config('veritymem.purposes', to_jsonb(COALESCE(p_purposes, ARRAY[]::text[]))::text, true);
  PERFORM set_config('veritymem.action', COALESCE(p_action, 'read'), true);

  -- Planning intentionally binds no scopes. Fail closed without scanning the
  -- tenant's scope catalog merely to prove that an empty set reaches nothing.
  IF COALESCE(array_length(p_scope_ids, 1), 0) = 0
     OR COALESCE(array_length(p_purposes, 1), 0) = 0 THEN
    PERFORM set_config('veritymem.reachable_scope_ids', '{}', true);
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(inner_scope.scope_id ORDER BY inner_scope.scope_id), ARRAY[]::uuid[])
    INTO v_reachable
    FROM scopes inner_scope
   WHERE inner_scope.tenant_id = p_tenant
     AND COALESCE(array_length(p_purposes, 1), 0) > 0
     AND COALESCE(array_length(inner_scope.purpose, 1), 0) > 0
     AND inner_scope.purpose && p_purposes
     AND EXISTS (
       SELECT 1
         FROM scopes outer_scope
        WHERE outer_scope.scope_id = ANY(COALESCE(p_scope_ids, ARRAY[]::uuid[]))
          AND outer_scope.tenant_id = p_tenant
          AND outer_scope.tenant_id = inner_scope.tenant_id
          -- The same directional rule as `scope_contains`: an unbound caller
          -- dimension is broad; a bound one must equal the row's binding.
          AND (outer_scope.project    IS NULL OR outer_scope.project    = inner_scope.project)
          AND (outer_scope.user_id    IS NULL OR outer_scope.user_id    = inner_scope.user_id)
          AND (outer_scope.agent_id   IS NULL OR outer_scope.agent_id   = inner_scope.agent_id)
          AND (outer_scope.session_id IS NULL OR outer_scope.session_id = inner_scope.session_id)
     );

  PERFORM set_config('veritymem.reachable_scope_ids', v_reachable::text, true);
END;
$$;

CREATE OR REPLACE FUNCTION veritymem.set_system_context(p_tenant UUID, p_actor TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'a system context requires a tenant; there is no tenant-less system scope'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('veritymem.tenant_id', p_tenant::text, true);
  PERFORM set_config('veritymem.principal_id', COALESCE(p_actor, 'system'), true);
  PERFORM set_config('veritymem.system', 'true', true);
  PERFORM set_config('veritymem.scope_ids', '[]', true);
  PERFORM set_config('veritymem.reachable_scope_ids', '{}', true);
  PERFORM set_config('veritymem.purposes', '[]', true);
END;
$$;

CREATE OR REPLACE FUNCTION veritymem.scope_reachable(p_scope UUID, p_purposes TEXT[])
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    p_scope IS NOT NULL
    AND COALESCE(array_length(p_purposes, 1), 0) > 0
    AND p_scope = ANY(veritymem.current_reachable_scope_ids()),
    FALSE
  )
$$;

CREATE OR REPLACE FUNCTION veritymem.row_authorized(p_tenant UUID, p_scope UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    p_tenant IS NOT NULL
    AND p_tenant = veritymem.current_tenant_id()
    AND (
      veritymem.system_context()
      OR (
        COALESCE(array_length(veritymem.current_purposes(), 1), 0) > 0
        AND p_scope = ANY(veritymem.current_reachable_scope_ids())
      )
    ),
    FALSE
  )
$$;

GRANT EXECUTE ON FUNCTION veritymem.current_reachable_scope_ids() TO veritymem_app;

-- Deterministic migration-time proof of direction, tenant and purpose boundaries.
DO $$
DECLARE
  v_tenant       UUID := gen_random_uuid();
  v_other_tenant UUID := gen_random_uuid();
  v_project      UUID := gen_random_uuid();
  v_user         UUID := gen_random_uuid();
  v_other_proj   UUID := gen_random_uuid();
  v_foreign      UUID := gen_random_uuid();
BEGIN
  INSERT INTO scopes (scope_id, tenant_id, project, purpose) VALUES
    (v_project,    v_tenant,       'payments', ARRAY['latency_self_check']),
    (v_other_proj, v_tenant,       'hr',       ARRAY['latency_self_check']),
    (v_foreign,    v_other_tenant, 'payments', ARRAY['latency_self_check']);
  INSERT INTO scopes (scope_id, tenant_id, project, user_id, purpose) VALUES
    (v_user, v_tenant, 'payments', 'alice', ARRAY['latency_self_check']);

  PERFORM veritymem.set_request_context(
    v_tenant,
    'self-check',
    ARRAY[v_project],
    ARRAY['latency_self_check'],
    'verify'
  );

  IF NOT (v_project = ANY(veritymem.current_reachable_scope_ids()))
     OR NOT (v_user = ANY(veritymem.current_reachable_scope_ids())) THEN
    RAISE EXCEPTION 'self-check failed: a project scope did not expand to its user scope';
  END IF;
  IF v_other_proj = ANY(veritymem.current_reachable_scope_ids())
     OR v_foreign = ANY(veritymem.current_reachable_scope_ids()) THEN
    RAISE EXCEPTION 'self-check failed: precomputed reach crossed a project or tenant boundary';
  END IF;
  IF NOT veritymem.row_authorized(v_tenant, v_user) THEN
    RAISE EXCEPTION 'self-check failed: a reachable row was denied';
  END IF;

  PERFORM veritymem.set_request_context(
    v_tenant,
    'self-check',
    ARRAY[v_user],
    ARRAY['latency_self_check'],
    'verify'
  );
  IF v_project = ANY(veritymem.current_reachable_scope_ids()) THEN
    RAISE EXCEPTION 'self-check failed: a user scope widened to its project scope';
  END IF;

  PERFORM veritymem.set_request_context(
    v_tenant,
    'self-check',
    ARRAY[v_project],
    ARRAY[]::text[],
    'verify'
  );
  IF COALESCE(array_length(veritymem.current_reachable_scope_ids(), 1), 0) <> 0 THEN
    RAISE EXCEPTION 'self-check failed: an empty purpose set reached a scope';
  END IF;

  RAISE EXCEPTION 'self-check rollback' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM <> 'self-check rollback' THEN
      RAISE;
    END IF;
END
$$;
