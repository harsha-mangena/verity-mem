# ADR 0005 — One authorization predicate shared by RLS and the query planner

**Status:** Accepted · v0.1 · **recorded after a real authorization bug was found and fixed**

## Context

Authorization here is not "is the caller authenticated". It is "does this row's
scope lie inside any scope the caller holds, in the caller's own tenant, for a
declared purpose". That question is asked in two places:

- by the query planner, before retrieval, because filtering after vector search
  leaks through counts, timings and generated summaries;
- by Postgres row-level security, as the backstop that catches a planner bug or a
  hand-written query that forgot a `WHERE` clause.

The first design gave each place its own expression. RLS got two permissive
policies per table:

```sql
CREATE POLICY events_tenant ON events
  USING (tenant_id = veritymem.current_tenant_id());
CREATE POLICY events_scope ON events
  USING (veritymem.scope_authorized(scope_id, scope_id, veritymem.current_purposes()));
```

## The bug

**Permissive policies are combined with `OR`.** A row was therefore visible when
*either* clause held, and the effective boundary was the **cheaper of the two
clauses**, not both.

Two consequences, one benign and one not:

- A row from a second tenant whose scope id the caller happened to name was
  admitted by the scope clause while being rejected by the tenant clause. The
  scope clause never checked that the caller's tenant matched the row's tenant —
  it trusted the caller's bound scope-id array. That is only sound if the array is
  itself trustworthy, and nothing verified it.
- An empty or unbound scope array was not a systematic deny *inside* the scope
  clause. That is a near-miss rather than an open hole, but it is exactly the kind
  of near-miss that becomes a leak after one refactor.

The same class of mistake — a permissive combination hiding a missing check — is
why the fix is architectural rather than a patch to one clause.

## Decision

One predicate, `veritymem.row_authorized(p_tenant UUID, p_scope UUID)`, used by
every scoped table's policy, defined in
`migrations/0006_scope_reach_predicate.sql`:

```sql
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
```

It answers one question per row: *does this row's scope lie inside any scope the
caller holds, in the caller's own tenant, for a declared purpose?* The three
clauses live inside `veritymem.scope_reachable()`, which is a single
`plpgsql STABLE` function, so same-tenant is checked in the same predicate as
scope reach and cannot be lost to `OR`-combination or to a future
`RESTRICTIVE`/`PERMISSIVE` change.

`COALESCE(..., FALSE)` is the load-bearing part. **A policy expression that
evaluates to `NULL` is treated as a pass by PostgreSQL.** An accidental `NULL` in
a policy is therefore an authorization bypass, and returning an explicit boolean
removes that entire class of bug rather than relying on nobody introducing one.

Every scoped policy was replaced in the same migration, and the old policies were
dropped:

| Table | Policy | Expression |
| --- | --- | --- |
| `events` | `events_authorized` | `veritymem.row_authorized(tenant_id, scope_id)` |
| `claims` | `claims_authorized` | `veritymem.row_authorized(tenant_id, scope_id)` |
| `claim_candidates` | `candidates_authorized` | `veritymem.row_authorized(tenant_id, requested_scope)` |
| `claim_embeddings` | `embeddings_authorized` | `EXISTS (... claims ...)` on read; tenant on write |
| `decisions` | `decisions_authorized` | tenant gate plus reachability through claim or candidate |
| `claim_relations` | `relations_reachable` | both endpoints reachable |
| `evidence_spans` | `spans_visible` | the span's event is visible |
| `grants`, `query_traces`, `retention_jobs` | `*_authorized` | `COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE)` |

The migration ships a **self-check** that runs in the same transaction as the
change, so a regression aborts the migration rather than shipping:

```sql
IF veritymem.row_authorized(v_tenant, v_scope) THEN
  RAISE EXCEPTION 'self-check failed: authorized with no request context bound';
END IF;
...
IF veritymem.row_authorized(v_tenant, v_scope) THEN
  RAISE EXCEPTION 'self-check failed: authorized with an empty purpose set';
END IF;
IF veritymem.row_authorized(v_tenant, gen_random_uuid()) THEN
  RAISE EXCEPTION 'self-check failed: an unknown scope was authorized';
END IF;
```

## Consequences

- The planner and RLS cannot disagree, because there is one implementation. The
  same predicate is reachable from SQL by the application role
  (`GRANT EXECUTE ON FUNCTION veritymem.row_authorized(UUID, UUID) TO veritymem_app`),
  so a planner that wants to filter first can call the identical function rather
  than reimplementing containment in TypeScript.
- A missing `WHERE` clause stops being a leak and becomes an empty result.
  `Db.query()` refuses to run outside a request context at all; `Db.systemQuery()`
  returns zero rows from a scoped table because every predicate evaluates to
  `NULL` → `FALSE`. Test: *"fails closed at the database when no request context is
  bound"* (`packages/ledger/src/ledger.test.ts`).
- **Harder:** one predicate is on the hot path of every scoped read, and it is
  `plpgsql STABLE` rather than `sql IMMUTABLE`. It does one `scopes` lookup and
  parses a JSONB array per row. The v0.1 exit target (p95 non-LLM query under
  250 ms at one million accepted claims) has not been measured against this, and a
  per-row function call is the first thing to look at if it fails.
- **Harder:** the predicate reads the caller's scopes through
  `veritymem.caller_scopes()`, which selects from the global `scopes` table. That
  makes the predicate read a table which itself has no RLS (see
  `docs/threat-model.md`, known limitations).
- **Harder:** there is now exactly one place to get authorization right, which also
  means exactly one place to get it wrong. The self-check blocks in
  `migrations/0005` and `migrations/0006` are the mechanism that makes that
  acceptable, and any future change to the predicate must add one.

## Verification

| Claim | Where it is proved |
| --- | --- |
| No request context ⇒ deny | self-check in `migrations/0006_scope_reach_predicate.sql`; test *"fails closed at the database when no request context is bound"* |
| Foreign tenant ⇒ deny | self-check in `migrations/0006`; test *"does not expose another tenant's events to a scoped query"* |
| Empty purpose ⇒ deny | self-check in `migrations/0006`; test *"treats purpose as a hard boundary"* |
| Empty caller purpose set ⇒ deny | self-check in `migrations/0005_purpose_predicate_fix.sql` |
| Unknown scope ⇒ deny | self-check in `migrations/0006` |
| Different project ⇒ deny | test *"blocks a different project within the same tenant"* |
| Sibling user under a user-scoped caller ⇒ deny | test *"keeps a user-scoped caller inside that user"* |
| Project-scoped caller reaches users in that project | test *"lets a project-scoped caller reach every user in that project"* |

All eight ran green on the reference database at the time of writing
(`pnpm test`: 28 tests, 28 pass, 0 fail).

## Alternatives rejected

**Patch the scope clause to add a tenant check, keep two policies.** Rejected:
this fixes the instance and leaves the class. Any future table, any future policy,
and any future `RESTRICTIVE`/`PERMISSIVE` change can reintroduce an `OR` that
weakens the boundary. The bug was not "a missing tenant check", it was "the
boundary was the union of two independently-written expressions".

**`FORCE ROW LEVEL SECURITY` on every table.** Considered and not adopted. The
application role is already `NOSUPERUSER NOBYPASSRLS`
(`deploy/compose/initdb/01-extensions.sql`), so policies are load-bearing for it
today; `FORCE` would additionally bind the table owner, which matters only if the
owner connection is ever used for tenant reads. It is a cheap hardening to add
later and is listed as a known limitation rather than silently assumed.

**Move authorization entirely into the application.** Rejected: it makes every
future hand-written query a potential leak, and it removes the property that a
missing `WHERE` clause yields nothing rather than everything.
