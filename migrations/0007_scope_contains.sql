-- 0007_scope_reach.sql
--
-- There is exactly one containment rule in this system, and it is *directional*:
--
--     can a caller holding scope `outer` reach a claim recorded in scope `inner`?
--
-- The rule, applied per dimension (project, user, agent, session):
--
--   * `outer` binds nothing on the dimension -> the row is reached on that
--     dimension, whatever either scope binds there
--   * `outer` binds a value -> `inner` must bind the same value. A row scope that
--     leaves the dimension unbound is *not* reached, because "no value" is not
--     "the caller\'s value", and treating it as one is how a user-scoped caller
--     would silently inherit a project-wide resource.
--
-- Tenant must match, always. Purposes are a separate gate, handled by
-- `scope_reachable` rather than here.
--
-- Two consequences, and both matter:
--
--   * The relation is NOT symmetric and is not a set-theoretic subset test. A
--     project-wide caller reaches every *user-scoped* record inside that project,
--     which is intended. A caller bound to one user does not reach the project-wide
--     scope it sits inside, which is what stops one user's access from silently
--     widening into the whole project.
--   * A record whose scope leaves a dimension unbound is reachable only by a caller
--     that also leaves it unbound. "No value" is not "the caller's value": treating
--     it as one would make a project-agnostic record readable from inside every
--     project that shares the other dimensions, which is implicit scope broadening
--     and is the failure this rule exists to prevent.
--   * Because it is a predicate rather than a transitive closure, the query
--     planner can compute a caller's whole reachable set in one query. That is
--     what keeps the retrieval path free of hundreds of round trips.
--
-- This migration exists because the rule was factored out of `scope_reachable`, so
-- that the RLS policy, the query planner and the channel filter all call one
-- implementation. Three implementations of one rule is three places for it to
-- drift.

CREATE OR REPLACE FUNCTION veritymem.scope_contains(p_outer UUID, p_inner UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM scopes o
      JOIN scopes i ON i.scope_id = p_inner
     WHERE o.scope_id = p_outer
       AND o.tenant_id = i.tenant_id
       -- The directional rule, per dimension. Read each clause as "the caller's
       -- binding is satisfied by the row". The leading `o.X IS NULL` branch is
       -- present only for the *caller*; that asymmetry is the entire difference
       -- between this and a symmetric containment test, and making it symmetric
       -- would let a user-bound caller reach its own project scope.
       AND (o.project    IS NULL OR o.project    = i.project)
       AND (o.user_id    IS NULL OR o.user_id    = i.user_id)
       AND (o.agent_id   IS NULL OR o.agent_id   = i.agent_id)
       AND (o.session_id IS NULL OR o.session_id = i.session_id)
  )
$$;

COMMENT ON FUNCTION veritymem.scope_contains(UUID, UUID) IS
  'Directional reach: can a caller holding the outer scope reach a claim in the inner scope? Per dimension: caller unbound means reached; both bound and equal means reached; caller bound and inner unbound means reached; both bound and different means no. Deliberately asymmetric. Tenant must match. Purposes are a separate gate.';

-- ---------------------------------------------------------------------------
-- The authorization predicate, built on the factored rule
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.scope_reachable(p_scope UUID, p_purposes TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_row_purposes TEXT[];
  v_row_tenant   UUID;
  v_caller       JSONB;
BEGIN
  -- Clause 1: the caller must declare a purpose. An empty purpose set is not a
  -- wildcard, it is the absence of an authorization basis, and it denies.
  IF p_purposes IS NULL OR COALESCE(array_length(p_purposes, 1), 0) = 0 THEN
    RETURN FALSE;
  END IF;
  IF p_scope IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Clause 2: the row's scope must exist and must name a purpose the caller
  -- declared. This is what makes an empty-purpose scope unreachable rather than
  -- universal.
  SELECT r.tenant_id, r.purpose INTO v_row_tenant, v_row_purposes
    FROM scopes r WHERE r.scope_id = p_scope;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF COALESCE(array_length(v_row_purposes, 1), 0) = 0 THEN
    RETURN FALSE;
  END IF;
  IF NOT (v_row_purposes && p_purposes) THEN
    RETURN FALSE;
  END IF;

  -- Clause 3: some scope the caller holds must reach the row's scope, in the
  -- caller's own tenant. The tenant check lives here rather than in a sibling
  -- policy so that OR-combination of permissive policies cannot lose it.
  SELECT c.value
    INTO v_caller
    FROM jsonb_array_elements(veritymem.caller_scopes()) AS c(value)
   WHERE (c.value ->> 'tenant_id')::uuid = v_row_tenant
     AND veritymem.scope_contains((c.value ->> 'scope_id')::uuid, p_scope)
   LIMIT 1;

  RETURN v_caller IS NOT NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Self-check
--
-- Data-driven self-checks are a trap: one that selects "any project scope" and
-- "any user scope" from whatever the database happens to contain either skips
-- itself when those rows do not exist, or asserts something that is not a property
-- of the function. An earlier version of this block did both — it passed silently
-- on an empty table and failed on a user scope whose project was NULL, which is a
-- scope that legitimately reaches every project.
--
-- These checks run against scopes constructed here, inside a transaction that is
-- rolled back, so they are deterministic and independent of the data.
DO $$
DECLARE
  v_tenant     UUID := gen_random_uuid();
  v_other      UUID := gen_random_uuid();
  v_project    UUID := gen_random_uuid();  -- project only
  v_user_proj  UUID := gen_random_uuid();  -- project + user alice
  v_user_only  UUID := gen_random_uuid();  -- user alice, no project
  v_other_proj UUID := gen_random_uuid();  -- a different project, same tenant
  v_foreign    UUID := gen_random_uuid();  -- same project name, different tenant
BEGIN
  INSERT INTO scopes (scope_id, tenant_id, project, purpose) VALUES
    (v_project,    v_tenant, 'payments', ARRAY['self_check']),
    (v_other_proj, v_tenant, 'hr',       ARRAY['self_check']),
    (v_foreign,    v_other,  'payments', ARRAY['self_check']);
  INSERT INTO scopes (scope_id, tenant_id, project, user_id, purpose) VALUES
    (v_user_proj, v_tenant, 'payments', 'alice', ARRAY['self_check']),
    (v_user_only, v_tenant, NULL,       'alice', ARRAY['self_check']);

  -- Reflexive.
  IF NOT veritymem.scope_contains(v_project, v_project) THEN
    RAISE EXCEPTION 'self-check failed: reach is not reflexive';
  END IF;

  -- Tenant is absolute, even when every other dimension matches.
  IF veritymem.scope_contains(v_project, v_foreign) THEN
    RAISE EXCEPTION 'self-check failed: reach crossed a tenant boundary';
  END IF;

  -- A dimension bound to different values on both sides is a barrier.
  IF veritymem.scope_contains(v_project, v_other_proj) THEN
    RAISE EXCEPTION 'self-check failed: a project reached a different project';
  END IF;

  -- The wildcard direction that matters in practice: the caller is unbound on the
  -- user dimension, so a project-scoped caller reaches every user scope inside
  -- that project. This is the "project-wide operator" shape.
  IF NOT veritymem.scope_contains(v_project, v_user_proj) THEN
    RAISE EXCEPTION 'self-check failed: a project scope did not reach a user scope in that project';
  END IF;

  -- The mirror case, and it is *not* reached: a scope that leaves a dimension
  -- unbound is not usable under a caller that binds it. A project-scoped caller
  -- does not reach a project-agnostic user scope, because that scope is a claim
  -- about the user in every project, and admitting it here would be exactly the
  -- implicit scope broadening this rule exists to prevent.
  IF veritymem.scope_contains(v_project, v_user_only) THEN
    RAISE EXCEPTION 'self-check failed: a project-bound scope reached a project-agnostic user scope';
  END IF;

  -- Selector-style narrowing: a caller that declares its user and does not narrow
  -- by project is not project-restricted, so it reaches that user's claims in any
  -- project. This is the shape the documented query API produces, where `user` is
  -- given and `project` is not.
  IF NOT veritymem.scope_contains(v_user_only, v_user_proj) THEN
    RAISE EXCEPTION 'self-check failed: a user-only selector did not reach that user''s project scope';
  END IF;

  -- The isolation property, and the reason the relation must be asymmetric: a
  -- user-bound caller must not reach the project scope it sits in, or it would
  -- inherit every other user in that project.
  IF veritymem.scope_contains(v_user_proj, v_project) THEN
    RAISE EXCEPTION 'self-check failed: a user-bound scope reached the project scope it sits in';
  END IF;

  -- And it must not reach a scope that leaves the project unbound, because
  -- reaching it would mean reaching that user in every project.
  IF veritymem.scope_contains(v_user_proj, v_user_only) THEN
    RAISE EXCEPTION 'self-check failed: a project-bound scope reached a project-agnostic user scope';
  END IF;

  RAISE EXCEPTION 'self-check rollback' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM <> 'self-check rollback' THEN
      RAISE;
    END IF;
END
$$;

GRANT EXECUTE ON FUNCTION veritymem.scope_contains(UUID, UUID) TO veritymem_app;
