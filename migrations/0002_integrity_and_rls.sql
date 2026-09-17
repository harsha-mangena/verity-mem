-- 0002_integrity_and_rls.sql — the invariants the database itself enforces.
--
-- Three classes of rule live here rather than in application code, because a
-- rule that only exists in application code is a rule that one code path will
-- eventually forget:
--   1. the ledger is append-only,
--   2. claim status follows the declared lifecycle,
--   3. a row is only visible to a caller whose resolved scope reaches it.

-- ---------------------------------------------------------------------------
-- Request context
--
-- The server opens a transaction per request and calls
--   veritymem.set_request_context(tenant, principal, scope_ids, purposes)
-- which sets transaction-local GUCs. Every read and write then carries the
-- caller's identity into the database, so policies cannot be bypassed by a
-- code path that forgets to add a WHERE clause.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS veritymem;

CREATE OR REPLACE FUNCTION veritymem.current_tenant_id() RETURNS UUID
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('veritymem.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION veritymem.current_principal_id() RETURNS TEXT
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('veritymem.principal_id', true), '') $$;

CREATE OR REPLACE FUNCTION veritymem.current_action() RETURNS TEXT
LANGUAGE sql STABLE
AS $$ SELECT COALESCE(NULLIF(current_setting('veritymem.action', true), ''), 'read') $$;

-- Scope ids the caller may reach, already expanded through grants by the
-- application and then *re-validated here*. The application proposes; the
-- database decides.
CREATE OR REPLACE FUNCTION veritymem.current_scope_ids() RETURNS UUID[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT array_agg(value::uuid)
       FROM jsonb_array_elements_text(
              COALESCE(NULLIF(current_setting('veritymem.scope_ids', true), ''), '[]')::jsonb
            ) AS value),
    ARRAY[]::uuid[]
  )
$$;

CREATE OR REPLACE FUNCTION veritymem.current_purposes() RETURNS TEXT[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT array_agg(value)
       FROM jsonb_array_elements_text(
              COALESCE(NULLIF(current_setting('veritymem.purposes', true), ''), '[]')::jsonb
            ) AS value),
    ARRAY[]::text[]
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
BEGIN
  PERFORM set_config('veritymem.tenant_id', p_tenant::text, true);
  PERFORM set_config('veritymem.principal_id', COALESCE(p_principal, ''), true);
  PERFORM set_config('veritymem.scope_ids', to_jsonb(COALESCE(p_scope_ids, ARRAY[]::uuid[]))::text, true);
  PERFORM set_config('veritymem.purposes', to_jsonb(COALESCE(p_purposes, ARRAY[]::text[]))::text, true);
  PERFORM set_config('veritymem.action', COALESCE(p_action, 'read'), true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Scope authorization
--
-- A caller scope reaches a row scope when every dimension the caller names
-- matches, the row does not narrow to a dimension the caller does not name,
-- and the purposes intersect.
--
-- Purpose semantics, stated once so no caller has to guess: an empty purpose
-- array on a claim means "reusable for the purposes of its scope lineage",
-- and an empty caller purpose array is unqualified. Otherwise the claim is
-- reachable when claim_purpose && caller_purpose is non-empty.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.scope_authorized(
  p_caller UUID, p_row UUID, p_purposes TEXT[]
) RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM scopes c
      JOIN scopes r ON r.scope_id = p_row
     WHERE c.scope_id = p_caller
       AND c.tenant_id = r.tenant_id
       AND (c.project    IS NULL OR c.project    = r.project)
       AND (c.user_id    IS NULL OR r.user_id    IS NULL OR c.user_id    = r.user_id)
       AND (c.agent_id   IS NULL OR r.agent_id   IS NULL OR c.agent_id   = r.agent_id)
       AND (c.session_id IS NULL OR r.session_id IS NULL OR c.session_id = r.session_id)
       AND (
         COALESCE(array_length(r.purpose, 1), 0) = 0
         OR COALESCE(array_length(p_purposes, 1), 0) = 0
         OR r.purpose && p_purposes
       )
  )
$$;

-- Set-returning form, used by the query planner to filter *before* retrieval.
CREATE OR REPLACE FUNCTION veritymem.authorized_scope_ids() RETURNS SETOF UUID
LANGUAGE sql STABLE
AS $$
  SELECT candidate
    FROM unnest(veritymem.current_scope_ids()) AS candidate
   WHERE veritymem.scope_authorized(candidate, candidate, veritymem.current_purposes())
$$;

-- ---------------------------------------------------------------------------
-- Append-only ledger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.reject_event_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'events are append-only: DELETE is not permitted (event_id=%)', OLD.event_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The single permitted mutation is retention redaction: payload bytes are
  -- removed while the hash, the chain and the row's existence are preserved.
  -- Deletion is proven by residual scan, so the ledger must still be able to
  -- testify that the event existed.
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_ref IS DISTINCT FROM OLD.payload_ref
     OR NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
    IF NEW.redacted_at IS NULL THEN
      RAISE EXCEPTION 'events are append-only: payload may only change via retention redaction'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.payload IS NOT NULL OR NEW.payload_ref IS NOT NULL THEN
      RAISE EXCEPTION 'retention redaction must clear both payload and payload_ref'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.stream_id IS DISTINCT FROM OLD.stream_id
     OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash
     OR NEW.byte_length IS DISTINCT FROM OLD.byte_length THEN
    RAISE EXCEPTION 'events are append-only: immutable column modified (event_id=%)', OLD.event_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION veritymem.reject_event_mutation();

CREATE OR REPLACE FUNCTION veritymem.reject_span_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evidence spans are immutable once written (span_id=%)',
    COALESCE(OLD.span_id, NEW.span_id)
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER evidence_spans_immutable
  BEFORE UPDATE OR DELETE ON evidence_spans
  FOR EACH ROW EXECUTE FUNCTION veritymem.reject_span_mutation();

-- ---------------------------------------------------------------------------
-- Claim lifecycle
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.valid_claim_transition(from_status claim_status, to_status claim_status)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE from_status
    WHEN 'proposed'   THEN to_status IN ('accepted','rejected','disputed','superseded','expired')
    WHEN 'accepted'   THEN to_status IN ('disputed','superseded','revoked','expired')
    WHEN 'disputed'   THEN to_status IN ('accepted','superseded','revoked','expired','rejected')
    WHEN 'superseded' THEN to_status IN ('revoked')
    WHEN 'rejected'   THEN to_status IN ('superseded')
    WHEN 'revoked'    THEN to_status IN ('superseded')
    WHEN 'expired'    THEN to_status IN ('superseded','accepted')
  END
$$;

CREATE OR REPLACE FUNCTION veritymem.enforce_claim_transition() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT veritymem.valid_claim_transition(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'illegal claim transition % -> % (claim_id=%)', OLD.status, NEW.status, OLD.claim_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A claim's identity is fixed at creation. Anything else would invalidate the
  -- evidence binding that makes the claim inspectable.
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.predicate IS DISTINCT FROM OLD.predicate
     OR NEW.origin_event_id IS DISTINCT FROM OLD.origin_event_id
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'claim identity columns are immutable (claim_id=%)', OLD.claim_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER claims_lifecycle
  BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION veritymem.enforce_claim_transition();

CREATE OR REPLACE FUNCTION veritymem.reject_claim_delete() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'claims are never deleted; use status=revoked plus a retention manifest (claim_id=%)', OLD.claim_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER claims_no_delete
  BEFORE DELETE ON claims
  FOR EACH ROW EXECUTE FUNCTION veritymem.reject_claim_delete();

-- ---------------------------------------------------------------------------
-- Lexical projection trigger
--
-- Kept as a trigger rather than a generated column because jsonb_to_tsvector is
-- not immutable. The projection is disposable: /v1/replay rebuilds it from the
-- ledger and must reach the same bytes.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION veritymem.claim_search_document(
  p_subject TEXT, p_predicate TEXT, p_object JSONB
) RETURNS TSVECTOR
LANGUAGE sql IMMUTABLE
AS $$
  SELECT to_tsvector('english'::regconfig, p_subject || ' ' || p_predicate) ||
         jsonb_to_tsvector('english'::regconfig, p_object, '["string","numeric","boolean"]'::jsonb)
$$;

CREATE OR REPLACE FUNCTION veritymem.claims_search_tsv() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_tsv := veritymem.claim_search_document(NEW.subject, NEW.predicate, NEW.object);
  RETURN NEW;
END;
$$;

CREATE TRIGGER claims_search_tsv
  BEFORE INSERT OR UPDATE OF subject, predicate, object ON claims
  FOR EACH ROW EXECUTE FUNCTION veritymem.claims_search_tsv();

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- The planner filters first; this catches planner bugs. Both gates are applied
-- on purpose: tenant equality is cheap and absolute, scope reach is the
-- authorization semantic. An unset context yields NULL and therefore denies.
-- ---------------------------------------------------------------------------

ALTER TABLE events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims             ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_candidates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_embeddings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_spans     ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_relations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE grants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE query_traces       ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_jobs     ENABLE ROW LEVEL SECURITY;

-- events
CREATE POLICY events_tenant ON events
  USING (tenant_id = veritymem.current_tenant_id())
  WITH CHECK (tenant_id = veritymem.current_tenant_id());
CREATE POLICY events_scope ON events
  USING (veritymem.scope_authorized(scope_id, scope_id, veritymem.current_purposes()))
  WITH CHECK (veritymem.scope_authorized(scope_id, scope_id, veritymem.current_purposes()));

-- claims
CREATE POLICY claims_tenant ON claims
  USING (tenant_id = veritymem.current_tenant_id())
  WITH CHECK (tenant_id = veritymem.current_tenant_id());
CREATE POLICY claims_scope ON claims
  USING (veritymem.scope_authorized(scope_id, scope_id, veritymem.current_purposes()))
  WITH CHECK (veritymem.scope_authorized(scope_id, scope_id, veritymem.current_purposes()));

-- claim_candidates
CREATE POLICY candidates_tenant ON claim_candidates
  USING (tenant_id = veritymem.current_tenant_id())
  WITH CHECK (tenant_id = veritymem.current_tenant_id());
CREATE POLICY candidates_scope ON claim_candidates
  USING (veritymem.scope_authorized(requested_scope, requested_scope, veritymem.current_purposes()))
  WITH CHECK (veritymem.scope_authorized(requested_scope, requested_scope, veritymem.current_purposes()));

-- evidence_spans: reachable exactly when their event is.
CREATE POLICY spans_visible ON evidence_spans
  USING (EXISTS (SELECT 1 FROM events e WHERE e.event_id = evidence_spans.event_id));

-- decisions and relations: no scope column, so tenant plus a reachability test
-- through the claim they describe.
CREATE POLICY decisions_tenant ON decisions
  USING (tenant_id = veritymem.current_tenant_id())
  WITH CHECK (tenant_id = veritymem.current_tenant_id());
CREATE POLICY decisions_reachable ON decisions
  USING (
    (claim_id IS NOT NULL AND EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = decisions.claim_id))
    OR (candidate_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM claim_candidates cc WHERE cc.candidate_id = decisions.candidate_id))
  );

CREATE POLICY relations_reachable ON claim_relations
  USING (
    EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = claim_relations.from_claim)
    AND EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = claim_relations.to_claim)
  );

-- claim_embeddings: a projection of claims, so it inherits their reachability.
CREATE POLICY embeddings_tenant ON claim_embeddings
  USING (tenant_id = veritymem.current_tenant_id())
  WITH CHECK (tenant_id = veritymem.current_tenant_id());
CREATE POLICY embeddings_reachable ON claim_embeddings
  USING (EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = claim_embeddings.claim_id))
  WITH CHECK (EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = claim_embeddings.claim_id));

-- grants and traces are tenant-scoped only.
CREATE POLICY grants_tenant ON grants
  USING (tenant_id = veritymem.current_tenant_id())
  WITH CHECK (tenant_id = veritymem.current_tenant_id());
CREATE POLICY traces_tenant ON query_traces
  USING (tenant_id = veritymem.current_tenant_id())
  WITH CHECK (tenant_id = veritymem.current_tenant_id());
CREATE POLICY retention_tenant ON retention_jobs
  USING (tenant_id = veritymem.current_tenant_id())
  WITH CHECK (tenant_id = veritymem.current_tenant_id());

-- ---------------------------------------------------------------------------
-- Application role grants
--
-- The application role is not a superuser and does not hold BYPASSRLS, so the
-- policies above are load-bearing rather than decorative.
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA veritymem TO veritymem_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO veritymem_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO veritymem_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA veritymem TO veritymem_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO veritymem_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO veritymem_app;
