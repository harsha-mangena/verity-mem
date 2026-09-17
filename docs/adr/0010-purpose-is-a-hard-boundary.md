# ADR 0010 — Purpose is a hard boundary, not a wildcard

**Status:** Accepted · v0.1 · **records a real authorization bug found by the test suite and fixed in `migrations/0005_purpose_predicate_fix.sql`**

## Context

Purpose is a first-class member of the scope tuple, not a tag. A claim admitted
for `release_planning` is not thereby available for `hr_review`, and
`WriteScopeSchema` in `packages/contracts/src/scope.ts` requires `purpose` to have
`minItems: 1` for exactly that reason.

The first containment predicate, in `migrations/0002_integrity_and_rls.sql`, read:

```sql
AND (
  COALESCE(array_length(r.purpose, 1), 0) = 0
  OR COALESCE(array_length(p_purposes, 1), 0) = 0
  OR r.purpose && p_purposes
)
```

Two conveniences were encoded in that expression, and each looked reasonable in
isolation:

- an empty `purpose` array on the **row's** scope meant "unrestricted";
- an empty caller purpose set meant "unqualified".

## The bug

**The two conveniences composed into a genuine authorization hole.**

A caller with no scopes bound at all satisfied `c.scope_id = p_caller` whenever the
row's scope id happened to equal the caller's, and a row whose purpose array was
empty matched unconditionally via the first `OR` branch.

The practical effect: events recorded with no purpose were readable outside any
purpose boundary, and the deny-by-default behaviour of row-level security could be
defeated for those rows. Because the caller clause only required
`c.scope_id = p_caller`, a row with an empty purpose array was reachable by *any*
caller whose bound scope array contained that scope id — including a caller whose
own purpose set was empty or unrelated.

This is the same shape as the bug in ADR 0005: a boundary expressed as a
*disjunction of conveniences* is the union of the weakest branch, not the
strongest. Both bugs were found by the ledger test suite rather than by review.

## Decision

Purpose has no wildcard. The corrected rule, stated once in
`veritymem.scope_authorized()` and later folded into
`veritymem.scope_reachable()` (ADR 0005):

1. a row's scope must name **at least one** purpose, and
2. the caller's purpose set must be **non-empty**, and
3. the two must **intersect**.

```sql
-- An empty purpose set is not a wildcard. It is the absence of an
-- authorization basis, and it denies.
IF p_purposes IS NULL OR COALESCE(array_length(p_purposes, 1), 0) = 0 THEN
  RETURN FALSE;
END IF;
...
IF COALESCE(array_length(v_row_purposes, 1), 0) = 0 THEN
  RETURN FALSE;
END IF;
IF NOT (v_row_purposes && p_purposes) THEN
  RETURN FALSE;
END IF;
```

The write path enforces condition 1 at admission, so an empty-purpose scope cannot
be created through the API at all. `veritymem.assert_purposes(p_purpose TEXT[])`
raises `check_violation` with the message *"a scope must declare at least one
purpose"*, and `veritymem.ensure_scope()` calls it **twice**: once on the raw input
and once on the de-duplicated, non-empty-filtered array. The second call is what
stops `ensure_scope(..., ARRAY[''])` from creating a scope whose only purpose is the
empty string.

**Being unreachable is the correct failure mode** for a scope row that predates
this fix. The migration does not attempt to repair old rows; it makes them
invisible, which is the safe direction.

## Verification

The migration ships a self-check that aborts the transaction on regression:

```sql
IF veritymem.scope_authorized(v_scope, v_scope, ARRAY[]::text[]) THEN
  RAISE EXCEPTION 'purpose predicate self-check failed: empty purpose set was authorized';
END IF;
IF veritymem.scope_authorized(v_scope, v_scope, NULL) THEN
  RAISE EXCEPTION 'purpose predicate self-check failed: NULL purpose set was authorized';
END IF;
IF NOT veritymem.scope_authorized(v_scope, v_scope, (SELECT purpose FROM scopes WHERE scope_id = v_scope)) THEN
  RAISE EXCEPTION 'purpose predicate self-check failed: a scope no longer reaches itself';
END IF;
```

The third assertion matters as much as the first two: a fix that denies everything
would pass a deny-only test suite while destroying the product. The self-check
proves both directions.

The behavioural test is *"treats purpose as a hard boundary"* in
`packages/ledger/src/ledger.test.ts`, which uses a random purpose name per run
because scopes accumulate purposes legitimately and a fixed name could resolve.

Against the reference database at the time of writing:

```
scope_authorized(<scope>, <scope>, ARRAY[]::text[])  -> false
row_authorized(<tenant>, <scope>)  with no request context -> false
row_authorized(<tenant>, <sibling-user scope>)  with only one user scope bound -> false
scope_reachable(<scope>, ARRAY['zzz_unrelated']) -> false
```

## Consequences

- `purpose` is a **required** write-scope field with `minItems: 1`. A caller cannot
  omit it, and `WriteScopeSchema` rejects an empty array at the edge.
- An old scope row with an empty purpose array is permanently unreachable. There is
  no repair path and no override; the only way to make its data reachable is to
  re-ingest it under a proper scope. This is a deliberate, one-way trade.
- **Harder:** there is no "any purpose" call shape. A supervisory read that
  legitimately spans purposes must enumerate them, and it must enumerate them in
  the caller's bound purpose set. There is no operator bypass short of a database
  credential.
- **Harder:** the `assert_purposes` guard lives inside a `SECURITY DEFINER`
  function, so the error surfaces as a Postgres `check_violation` and not as a
  typed application error. Callers see it through `ensureScope()`'s throw path,
  which classifies a missing scope row as `LedgerError("not_found", ..., 500)` —
  the `check_violation` itself propagates as a raw database error.
- **Harder:** purpose values are free-form strings up to 128 characters, sorted and
  de-duplicated on write (`Ledger.ensureScope` and `veritymem.ensure_scope` both do
  this, so two writes differing only in purpose order resolve to the same scope).
  There is no vocabulary enforcement, so a typo creates a new, disjoint boundary
  rather than an error. That is a recall bug waiting to happen and is listed in the
  known limitations of `docs/threat-model.md`.

## Alternatives rejected

**Keep the wildcard, but only for empty *row* purpose.** Rejected: it is the same
hole, just narrower. If an empty row purpose means "any purpose", the write path
has to guarantee no such row exists, and the guarantee would live in application
code rather than in the predicate.

**Keep the wildcard, but only for an empty *caller* purpose set.** Rejected: this
makes an *omitted* purpose the most privileged request in the system. Omission
should be the least privileged, which is why `Db.withRequest`'s `action` defaults
to `"read"` and `veritymem.current_action()` coalesces to `'read'`.

**Fail open with an audit warning.** Rejected: an authorization decision that is
logged but permitted is a decision that has already happened.

**Migrate old empty-purpose scopes to a synthetic `unassigned` purpose.** Rejected:
it would invent an authorization basis nobody granted. A `purpose` value that
appears in `scopes` but was never declared by a caller is exactly the kind of
implicit scope broadening this system exists to prevent.
