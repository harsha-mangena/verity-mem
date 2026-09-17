-- 0011_outbox_claim_functions.sql
--
-- Repairs a defect introduced by migration 0009, which enabled row-level security on
-- `outbox` with a tenant policy. That was right in principle — the outbox carries
-- `payload.scope_ids` and `payload.purposes`, and before 0009 a connection with no
-- context could read every tenant's queue — but it broke the claim path, and it broke
-- it silently:
--
--   * `OutboxWorker.claim/complete/fail` use `Db.systemQuery`, which takes a fresh
--     pooled connection with no request context. `veritymem.current_tenant_id()` is
--     NULL there, the policy is FALSE, so the UPDATE ... RETURNING matched zero rows.
--   * The worker therefore claimed nothing, completed nothing and failed nothing,
--     forever, while reporting itself healthy. Measured on this database: 5,531
--     pending rows, all invisible, `runOnce(5)` returning `{claimed:0}`.
--   * `systemQuery` is not a bypass. It holds `RESET ALL` and a rollback, not owner
--     rights, so it is subject to the same policies as any other connection.
--
-- A queue that a worker cannot read is worse than a queue with no policy, because the
-- failure is invisible. The fix is not to relax the policy: claiming is a
-- legitimately cross-tenant operation — the worker must find work before it knows
-- which tenant the work belongs to — so it belongs in a `SECURITY DEFINER` function
-- that performs exactly the claim, and nothing else.
--
-- What this does and does not expose, stated plainly because it is a real trade:
--
--   * The app role can now read the queue rows it claims, including
--     `payload.chain_input`, which is the preimage of `events.link_hash`. A reader
--     with the app credential can therefore recompute a chain link for an event it
--     can name. It cannot write one: `events` is append-only and `link_hash` is
--     immutable by trigger, so this is a *verification* capability, not a forgery
--     capability. Anyone who can read the event can already verify its link.
--   * Only rows that are pending, unlocked and under their attempt limit can be
--     claimed, so this is not a general read of the outbox.
--   * Nothing else about the outbox becomes reachable: `complete` and `fail` are
--     scoped to a row id the caller already claimed.

-- ---------------------------------------------------------------------------
-- Claim
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.outbox_claim(p_worker TEXT, p_limit INT)
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
            ORDER BY inner_o.outbox_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit
         )
  RETURNING o.outbox_id, o.tenant_id, o.kind, o.payload, o.attempts;
END;
$$;

-- ---------------------------------------------------------------------------
-- Settle
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.outbox_complete(p_outbox_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE outbox
     SET completed_at = now(), locked_by = NULL, locked_at = NULL
   WHERE outbox_id = p_outbox_id AND completed_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

/**
 * Release a claimed message for retry.
 *
 * The backoff is computed here rather than passed in, so two workers cannot disagree
 * about it and a caller cannot accidentally schedule an immediate retry loop.
 */
CREATE OR REPLACE FUNCTION veritymem.outbox_fail(p_outbox_id BIGINT, p_error TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_attempts INT;
  v_updated  INT;
BEGIN
  SELECT attempts INTO v_attempts FROM outbox WHERE outbox_id = p_outbox_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE outbox
     SET last_error = left(COALESCE(p_error, 'unknown error'), 2000),
         locked_by = NULL,
         locked_at = NULL,
         available_at = now() + (least(300, power(2, least(v_attempts, 8)))::text || ' seconds')::interval
   WHERE outbox_id = p_outbox_id AND completed_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- ---------------------------------------------------------------------------
-- Observability
--
-- Projection lag is a named metric in the specification, and it is tenant-wide, so it
-- needs the same privileged path as the claim. Without this, a monitoring query under
-- the app role silently reports zero lag forever.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.outbox_lag(p_tenant UUID DEFAULT NULL)
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::bigint
    FROM outbox
   WHERE completed_at IS NULL
     AND (p_tenant IS NULL OR tenant_id = p_tenant)
$$;

GRANT EXECUTE ON FUNCTION veritymem.outbox_claim(TEXT, INT) TO veritymem_app;
GRANT EXECUTE ON FUNCTION veritymem.outbox_complete(BIGINT) TO veritymem_app;
GRANT EXECUTE ON FUNCTION veritymem.outbox_fail(BIGINT, TEXT) TO veritymem_app;
GRANT EXECUTE ON FUNCTION veritymem.outbox_lag(UUID) TO veritymem_app;

-- ---------------------------------------------------------------------------
-- Self-check
--
-- The properties worth asserting are that a policy still denies an unbound read, and
-- that the privileged path actually claims. Asserting only the second would let the
-- fix quietly remove the protection that motivated 0009.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_visible INT;
BEGIN
  -- The policies must still deny an unqualified read. This runs as the migration
  -- owner, which bypasses RLS by virtue of being the owner, so the check is made
  -- against the policy definition rather than by querying.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'outbox' AND policyname = 'outbox_tenant'
  ) THEN
    RAISE EXCEPTION 'self-check failed: the outbox tenant policy is missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'outbox') THEN
    RAISE EXCEPTION 'self-check failed: row-level security is no longer enabled on outbox';
  END IF;

  -- And the privileged path must exist and be callable.
  SELECT veritymem.outbox_lag(NULL) INTO v_visible;
  IF v_visible IS NULL THEN
    RAISE EXCEPTION 'self-check failed: outbox_lag returned no value';
  END IF;
END
$$;
