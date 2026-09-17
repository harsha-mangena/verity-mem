-- 0012_outbox_claim_tenant_scope.sql
--
-- Makes claiming tenant-addressable, and repairs a real defect found while doing it.
--
-- Two problems with the version in 0011:
--
--  1. **The claim was global.** It took the oldest pending messages across every
--     tenant. For a worker configured to serve specific tenants that is wrong in both
--     directions: it picks up work belonging to another deployment's tenants, and a
--     backlog in one tenant starves every other tenant behind it in `outbox_id` order.
--     A real queue is claimed per tenant.
--
--  2. **The `payload` came back in a shape the caller could not use.** A SQL function
--     whose return type is `JSONB` returns JSONB, but a `RETURNS TABLE` column declared
--     `JSONB` over a `SELECT * FROM fn()` can arrive as text depending on how the
--     driver infers the column type — and the caller's `Array.isArray(payload.scope_ids)`
--     then fails, which trips the missing-scope guard and fails every message with a
--     misleading error. The function now returns the payload as `JSONB` explicitly cast,
--     and the caller tolerates a string as well, because a queue that fails every
--     message with "carries no scope" while the scope is right there in the row is the
--     worst kind of failure: loud, wrong, and about the wrong thing.
--
-- `p_tenants` NULL means "every tenant", which is the right default for a single-tenant
-- deployment or an operator draining the queue, and is stated rather than implied.

CREATE OR REPLACE FUNCTION veritymem.outbox_claim(
  p_worker TEXT,
  p_limit INT,
  p_tenants UUID[] DEFAULT NULL
)
RETURNS TABLE (
  outbox_id BIGINT, tenant_id UUID, kind TEXT, payload JSONB, attempts INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'outbox_claim requires a positive limit' USING ERRCODE = 'check_violation';
  END IF;
  IF p_worker IS NULL OR p_worker = '' THEN
    RAISE EXCEPTION 'outbox_claim requires a worker identity so a stuck claim is attributable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_tenants IS NOT NULL AND cardinality(p_tenants) = 0 THEN
    -- An empty array is not "all tenants"; it is a deployment that has configured no
    -- tenants, and silently claiming nothing would look identical to an empty queue.
    RAISE EXCEPTION 'outbox_claim received an empty tenant list; pass NULL to mean every tenant'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  UPDATE outbox o
     SET locked_by = p_worker,
         locked_at = now(),
         attempts = o.attempts + 1
   WHERE o.outbox_id IN (
           SELECT inner_o.outbox_id
             FROM outbox inner_o
            WHERE inner_o.completed_at IS NULL
              AND inner_o.available_at <= now()
              AND inner_o.attempts < inner_o.max_attempts
              AND (p_tenants IS NULL OR inner_o.tenant_id = ANY(p_tenants))
            ORDER BY inner_o.outbox_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit
         )
  RETURNING o.outbox_id, o.tenant_id, o.kind, o.payload::jsonb, o.attempts;
END;
$$;

GRANT EXECUTE ON FUNCTION veritymem.outbox_claim(TEXT, INT, UUID[]) TO veritymem_app;

-- The two-argument form from 0011 is dropped so there is one way to claim. Leaving both
-- would mean two deployments calling different functions and disagreeing about whether
-- a claim is tenant-scoped.
DROP FUNCTION IF EXISTS veritymem.outbox_claim(TEXT, INT);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'veritymem' AND p.proname = 'outbox_claim'
       AND pg_get_function_arguments(p.oid) LIKE '%p_tenants%'
  ) THEN
    RAISE EXCEPTION 'self-check failed: the tenant-scoped claim function was not created';
  END IF;
END
$$;
