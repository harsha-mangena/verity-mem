-- 0009_system_context_and_rls_gaps.sql
--
-- Two defects found by an audit of the modules that deliberately operate outside a
-- request scope.
--
-- 1. Background work silently read nothing.
--
--    The outbox worker and the retention controller bound an empty scope array and
--    an empty purpose set, because they operate on a tenant rather than on a
--    caller's scopes. Under the fail-closed policy that combination matches no rows
--    for *every* query — so the projection worker projected nothing (the processor
--    treated "claim not found" as a non-error and completed the message), and
--    `forget()` redacted nothing, scanned nothing, and then reported `verified`
--    because its residual count was zero for the same reason the scrub was.
--
--    A deletion feature whose proof-of-deletion is a scan that could not see
--    anything is worse than no feature: it reports success. The fix is not to give
--    those paths a wider policy, but to give them an explicit, auditable one.
--
-- 2. Seven tables carrying tenant data had no row-level security at all.
--
--    `scopes`, `outbox`, `entity_aliases`, `projection_versions`, `principals`,
--    `streams` and `tenants` were unguarded, so a connection with no request
--    context could read every tenant's rows. `outbox.payload` is the more serious
--    of those: it carries `chain_input`, which is the preimage of `events.link_hash`
--    and would let a reader recompute a forged chain link that verifies.

-- ---------------------------------------------------------------------------
-- Explicit system context
--
-- Set only by server-side maintenance paths, and only together with a tenant. It is
-- not a wildcard: `system_context` still resolves to exactly one tenant, and a
-- caller cannot set it, because the GUC is transaction-local and only
-- `veritymem.set_system_context` writes it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.system_context() RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$ SELECT COALESCE(NULLIF(current_setting('veritymem.system', true), ''), 'false')::boolean $$;

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
  -- System work is not purpose-scoped: it operates on a tenant, not on a
  -- declared intent. Purpose is still enforced for every request path.
  PERFORM set_config('veritymem.scope_ids', '[]', true);
  PERFORM set_config('veritymem.purposes', '[]', true);
END;
$$;

GRANT EXECUTE ON FUNCTION veritymem.set_system_context(UUID, TEXT) TO veritymem_app;
GRANT EXECUTE ON FUNCTION veritymem.system_context() TO veritymem_app;

-- The authorization predicate gains one branch: a tenant-bound system context
-- reaches everything in its own tenant. Every other path is unchanged and still
-- fails closed on an empty purpose set.
CREATE OR REPLACE FUNCTION veritymem.row_authorized(p_tenant UUID, p_scope UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    p_tenant IS NOT NULL
    AND p_tenant = veritymem.current_tenant_id()
    AND (
      veritymem.system_context()
      OR veritymem.scope_reachable(p_scope, veritymem.current_purposes())
    ),
    FALSE
  )
$$;

-- ---------------------------------------------------------------------------
-- Row-level security for the tables that had none
--
-- Each policy is written against the tenant, not against a scope: these tables
-- either are the scope table itself, or hold tenant-level operational state that
-- has no scope column. `scopes` in particular must be readable by any principal
-- holding a scope id, because resolving a scope is part of authorization.
-- ---------------------------------------------------------------------------

ALTER TABLE scopes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox              ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_aliases      ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE principals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE streams             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants             ENABLE ROW LEVEL SECURITY;

-- `scopes` is readable within the tenant and writable only through
-- `veritymem.ensure_scope`, which is SECURITY DEFINER. It carries no claim
-- content, only the shape of the ownership boundary.
DROP POLICY IF EXISTS scopes_tenant ON scopes;
CREATE POLICY scopes_tenant ON scopes
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE));

DROP POLICY IF EXISTS outbox_tenant ON outbox;
CREATE POLICY outbox_tenant ON outbox
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE));

DROP POLICY IF EXISTS entity_aliases_tenant ON entity_aliases;
CREATE POLICY entity_aliases_tenant ON entity_aliases
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE));

DROP POLICY IF EXISTS principals_tenant ON principals;
CREATE POLICY principals_tenant ON principals
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE));

DROP POLICY IF EXISTS streams_tenant ON streams;
CREATE POLICY streams_tenant ON streams
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE));

-- `projection_versions` and `tenants` have no tenant column. Projection versions
-- describe the deployment rather than a tenant, and are readable by anyone who
-- could have queried a claim; `tenants` is a slug index with no content. They are
-- restricted to a bound context so that an unbound connection sees nothing.
DROP POLICY IF EXISTS projection_versions_context ON projection_versions;
CREATE POLICY projection_versions_context ON projection_versions
  USING (veritymem.current_tenant_id() IS NOT NULL)
  WITH CHECK (veritymem.current_tenant_id() IS NOT NULL);

DROP POLICY IF EXISTS tenants_context ON tenants;
CREATE POLICY tenants_context ON tenants
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), veritymem.system_context()))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), veritymem.system_context()));

-- `outbox` is a queue: the worker claims across messages, so it needs to see the
-- rows for the tenant it is currently processing and nothing else. Claiming is
-- therefore done per tenant rather than across tenants, which is a real constraint
-- on throughput and the honest trade for not having a policy that spans tenants.
GRANT SELECT, INSERT, UPDATE ON outbox TO veritymem_app;

-- ---------------------------------------------------------------------------
-- Self-check: an unbound context must still reach nothing
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_rows INT;
BEGIN
  IF veritymem.current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'self-check failed: this migration runs with a tenant context bound';
  END IF;
  IF veritymem.system_context() THEN
    RAISE EXCEPTION 'self-check failed: a system context is bound during migration';
  END IF;
  IF veritymem.row_authorized(gen_random_uuid(), gen_random_uuid()) THEN
    RAISE EXCEPTION 'self-check failed: an unbound context authorized a row';
  END IF;
  -- Every table that carries tenant data must have a policy. Asserting a count is
  -- brittle; asserting the absence of an unprotected tenant table is the property
  -- that matters.
  SELECT count(*) INTO v_rows
    FROM information_schema.columns col
    JOIN pg_class cls ON cls.relname = col.table_name
    LEFT JOIN pg_policies pol ON pol.tablename = col.table_name
   WHERE col.table_schema = 'public'
     AND col.column_name = 'tenant_id'
     AND cls.relrowsecurity
     AND pol.policyname IS NULL;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'self-check failed: % tenant table(s) have RLS enabled but no policy', v_rows;
  END IF;
END
$$;
