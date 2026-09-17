-- 0008_principal_scopes.sql
--
-- Closes a gap in the read path that the retrieval tests surfaced: the caller's
-- reach was derived entirely from the *request* — the scope selector it declared,
-- plus any grants naming it. Nothing server-side recorded which scopes a principal
-- actually belongs to.
--
-- The consequence was that a request naming only a tenant and a project was
-- treated as "the caller is the project", and the containment rule then handed it
-- every user scope in that project. Row-level security did not stop it, because
-- the planner had legitimately put those scope ids into the bound set. In other
-- words the failure was not a policy bug; it was the planner answering "what may
-- this caller reach?" from an assertion the caller made about itself.
--
-- With this table, reach is computed from state the server owns:
--
--     reach(principal) = scopes(principal) ∪ grants(principal)
--
-- and the request's selector can only *narrow* that set, never widen it. A caller
-- that wants to read another user's claims now needs a grant naming that user,
-- which is the intended amount of ceremony for cross-user access.
--
-- Membership is recorded when a principal writes. That is the moment the server
-- has already authenticated the principal and bound the scope, so it is the one
-- place where "this principal belongs to this scope" is established by something
-- other than the principal saying so.

CREATE TABLE principal_scopes (
  tenant_id    UUID NOT NULL,
  principal_id TEXT NOT NULL,
  scope_id     UUID NOT NULL REFERENCES scopes(scope_id),
  -- How membership arose, so an operator can tell an organic membership from a
  -- granted one and revoke the right thing.
  source       TEXT NOT NULL CHECK (source IN ('participant','grant','admin')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id, scope_id)
);

CREATE INDEX principal_scopes_lookup_idx ON principal_scopes (tenant_id, principal_id);

ALTER TABLE principal_scopes ENABLE ROW LEVEL SECURITY;

-- Membership rows are readable exactly by the principal they describe. This is a
-- deliberately narrow policy: the row is the principal's own access list, and an
-- operator inspecting someone else's access list is an administrative action, not
-- a request-scoped read.
CREATE POLICY principal_scopes_own ON principal_scopes
  USING (
    tenant_id = veritymem.current_tenant_id()
    AND principal_id = veritymem.current_principal_id()
  )
  WITH CHECK (
    tenant_id = veritymem.current_tenant_id()
  );

GRANT SELECT, INSERT ON principal_scopes TO veritymem_app;

-- Recording membership is a SECURITY DEFINER function because the write path
-- needs to record it for the *acting* principal before the request context exists,
-- and because a participant membership should not be forgeable by a caller that
-- has merely bound a scope id.
CREATE OR REPLACE FUNCTION veritymem.record_participation(
  p_tenant UUID, p_principal TEXT, p_scope UUID
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO principal_scopes (tenant_id, principal_id, scope_id, source)
  VALUES (p_tenant, p_principal, p_scope, 'participant')
  ON CONFLICT (tenant_id, principal_id, scope_id) DO NOTHING
$$;

GRANT EXECUTE ON FUNCTION veritymem.record_participation(UUID, TEXT, UUID) TO veritymem_app;

-- Backfill from the ledger so an existing deployment does not lose access: every
-- event's actor is a participant in the scope the event was recorded in.
INSERT INTO principal_scopes (tenant_id, principal_id, scope_id, source)
SELECT DISTINCT e.tenant_id, e.actor_id, e.scope_id, 'participant'
  FROM events e
ON CONFLICT (tenant_id, principal_id, scope_id) DO NOTHING;
