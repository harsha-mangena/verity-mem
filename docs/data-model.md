# VerityMem data model

How `migrations/0001_core.sql` through `0006_scope_reach_predicate.sql` implement the
data model, and what a reader can query directly.

This document describes **the schema that exists**, not the schema in the
specification. Where the two differ, the difference is called out. Every column
name, enum value and constraint below was read from `migrations/*.sql` and verified
against a live database with `information_schema` and `pg_policies` queries (see
the verification note at the end).

---

## 1. Four objects, four lifecycles

There is no `memory` table. The distance between "something was observed" and "the
system believes it" is crossed once, by the commit gate, and the four objects on
either side of that crossing have separate lifecycles and separate mutability
rules.

```
events ──┐
         │  (immutable, append-only)
         ▼
   evidence_spans ──┐
         │          │  (immutable once written)
         ▼          │
claim_candidates ───┤  (mutable: state pending→extracted→validated→gated|failed)
  + candidate_evidence
         │
         ▼  commit gate: CommitGate.evaluate()
      claims ────────┐  (lifecycle-constrained: status transitions checked by trigger)
  + claim_evidence   │
  + claim_relations ─┘
         │
         ▼
     decisions          (append-only in practice; one row per promotion act)
```

| Object | Table(s) | Lifecycle | Mutability |
| --- | --- | --- | --- |
| **Evidence** | `events`, `evidence_spans` | Not applicable — evidence is not a state machine | Immutable except retention redaction of `payload`/`payload_ref`/`redacted_at` |
| **Candidate** | `claim_candidates`, `candidate_evidence` | `pending` → `extracted` → `validated` → `gated` \| `failed` | Rows are mutable; nothing in the schema prevents a `state` rewrite |
| **Claim** | `claims`, `claim_evidence`, `claim_relations` | `proposed` → `accepted` ↔ `disputed` → `superseded` → `revoked`, plus `rejected` and `expired` | `status` may change only along declared edges; identity columns are frozen; **`object`, `authority`, `valid_from`, `valid_to`, `expires_at` and `scope_id` are not** (see §9) |
| **Decision** | `decisions` | Append-only record of one promotion act | No delete trigger; a `DELETE` is blocked only by the absence of an RLS policy that would admit it |

### 1.1 The claim status machine is enforced by trigger, not by convention

`veritymem.valid_claim_transition(from_status, to_status)` is an `IMMUTABLE` SQL
function returning a boolean, and `veritymem.enforce_claim_transition()` is a
`BEFORE UPDATE ... FOR EACH ROW` trigger (`claims_lifecycle`) that raises
`check_violation` on an illegal edge.

| From | Legal targets |
| --- | --- |
| `proposed` | `accepted`, `rejected`, `disputed`, `superseded`, `expired` |
| `accepted` | `disputed`, `superseded`, `revoked`, `expired` |
| `disputed` | `accepted`, `superseded`, `revoked`, `expired`, `rejected` |
| `superseded` | `revoked` |
| `rejected` | `superseded` |
| `revoked` | `superseded` |
| `expired` | `superseded`, `accepted` |

Note that `accepted → proposed` is illegal, and `rejected → accepted` is illegal.
There is no path from a rejected claim to an accepted one; a re-proposal is a new
candidate and a new claim.

Claim **identity is frozen at creation**: `tenant_id`, `kind`, `subject`,
`predicate`, `origin_event_id` and `recorded_at` are checked on every `UPDATE` and
raise `restrict_violation` if changed.

There are exactly three statements in this repository that write `claims.status`,
and none of them can reach `'accepted'` from outside the gate:

| Statement | Location | Writes |
| --- | --- | --- |
| The `INSERT INTO claims (...)` in `CommitGate.insertClaim()` | `packages/gate/src/commit-gate.ts` | `'accepted'`, with the literal in the SQL, reached only by `CommitGate.evaluate()` for outcomes `accept` and `accept_limited_scope` |
| `UPDATE claims SET status = 'superseded', valid_to = $2` in the same method | `packages/gate/src/commit-gate.ts` | `'superseded'`, for an accepted claim this candidate duplicates or supersedes |
| `claims.applyStatus()` | `packages/claims/src/index.ts` | A caller-supplied status; the database rejects `'accepted'` from an illegal predecessor state |

Confirmed by `grep -rn "SET status\|status = '" --include="*.ts" packages/ apps/ scripts/`,
which returns only those three sites plus read-side predicates.

Extractors cannot reach any of them: an `Extractor.extract()` returns
`readonly Proposal[]`, and `Proposal` (`packages/model-adapters/src/extractor.ts`)
has no `status` field. **The invariant "no model call sets `status = accepted`" is
therefore a property of the interface, not a promise.** It is *not*, however, a
property of the database — see §9.

### 1.2 The batching columns the specification does not have

`claims` carries four columns the specification's `claims` table omits, all of
which the gate writes:

| Column | Why |
| --- | --- |
| `origin_event_id UUID REFERENCES events(event_id)` | The claim's originating event, queryable without going through `claim_evidence` |
| `extractor TEXT` | `name@version` from `claim_candidates.extractor` |
| `model_version TEXT` | Copied from the candidate; null for deterministic extractors |
| `prompt_version TEXT` | Copied from the candidate; null for deterministic extractors |

`claim_relations` also carries `recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
which the specification's version omits. Without it, "when did the system come to
believe these two claims contradict each other" has no answer.

---

## 2. Spans: byte offsets and per-span digests

```sql
CREATE TABLE evidence_spans (
  span_id     UUID PRIMARY KEY,
  event_id    UUID NOT NULL REFERENCES events(event_id),
  start_off   INT NOT NULL,        -- inclusive byte offset
  end_off     INT NOT NULL,        -- exclusive byte offset
  selector    TEXT,                -- reserved for structured/DOM payloads
  span_digest BYTEA NOT NULL,      -- SHA-256 over the payload slice [start_off, end_off)
  quote       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_off > start_off),
  CHECK (start_off >= 0)
);
CREATE INDEX evidence_spans_event_idx ON evidence_spans (event_id);
CREATE UNIQUE INDEX evidence_spans_identity_idx
  ON evidence_spans (event_id, start_off, end_off, COALESCE(selector, ''));
```

The span model is **`[start, end)` in bytes into `events.payload`**, where the
payload is the UTF-8 encoding of the event content. Offsets are not character
offsets, not UTF-16 code-unit offsets, and not chunk ids.

### 2.1 Why digests are checked on every read

`span_digest` says *"the bytes at these offsets are unchanged"*. `events.content_hash`
says *"this payload is unchanged"*. They are different questions, and a payload
rewrite, a migration, or a re-encoding can preserve the second while breaking the
first.

`Ledger.verifySpan()` (`packages/ledger/src/ledger.ts`) recomputes
`sha256Hex(payload.subarray(span.start, span.end))` and returns a discriminated
union:

| `SpanVerification.status` | Reason code emitted by `CommitGate.verifyEvidence()` |
| --- | --- |
| `ok` | `span.resolved` |
| `redacted` | `span.event_redacted`, `span.unresolvable` |
| `digest_mismatch` | `span.digest_mismatch`, `span.unresolvable` |
| `out_of_bounds` | `span.out_of_bounds`, `span.unresolvable` |
| `missing` | `span.unresolvable` |

The check runs on the gate path (`CommitGate.verifyEvidence()`), on the validation
path (`validateSpans()` in `packages/gate/src/validation.ts`) and on every read
that returns evidence — `ClaimEvidenceRef.digest_ok` in
`packages/contracts/src/claim.ts` is documented as *"Recomputed on this read, not
cached."*

Span creation is idempotent by identity: writing the same `(event_id, start_off,
end_off, selector)` twice returns the existing `span_id`. `Ledger.writeSpan()`
relies on the unique index and re-reads the winner, which also makes it safe under
concurrent writers.

### 2.2 Querying spans

```sql
-- Every span for an event, with the exact bytes it cites
SELECT span_id, start_off, end_off, encode(span_digest, 'hex') AS digest, quote
  FROM evidence_spans
 WHERE event_id = $1
 ORDER BY start_off;

-- Locate a claim's evidence, including the role each span plays
SELECT ce.role, s.span_id, s.event_id, s.start_off, s.end_off, s.quote
  FROM claim_evidence ce
  JOIN evidence_spans s USING (span_id)
 WHERE ce.claim_id = $1;
```

---

## 3. Append-only enforcement

Six triggers, in two migrations. The column `relrowsecurity` and trigger inventory
below were read from `pg_class` and `pg_trigger` on a live database.

| Table | Trigger | Function | Timing / scope |
| --- | --- | --- | --- |
| `events` | `events_append_only` | `veritymem.reject_event_mutation()` | `BEFORE UPDATE OR DELETE`, `FOR EACH ROW` |
| `events` | `events_no_delete` | `veritymem.reject_event_delete()` | `BEFORE DELETE`, **`FOR EACH STATEMENT`** |
| `evidence_spans` | `evidence_spans_immutable` | `veritymem.reject_span_mutation()` | `BEFORE UPDATE OR DELETE`, `FOR EACH ROW` |
| `claims` | `claims_lifecycle` | `veritymem.enforce_claim_transition()` | `BEFORE UPDATE`, `FOR EACH ROW` |
| `claims` | `claims_no_delete` | `veritymem.reject_claim_delete()` | `BEFORE DELETE`, `FOR EACH ROW` |
| `claims` | `claims_search_tsv` | `veritymem.claims_search_tsv()` | `BEFORE INSERT OR UPDATE OF subject, predicate, object`, `FOR EACH ROW` |

### 3.1 Why the statement-level DELETE guard exists

`veritymem.reject_event_mutation()` is a **row-level** trigger, and PostgreSQL does
not run a row-level trigger for a `DELETE` that matches zero rows.

That is usually irrelevant — deleting nothing changes nothing — but it produces the
wrong asymmetry for a guard: `DELETE FROM events WHERE event_id = $1` (one row)
raises, while `DELETE FROM events` (a full-table delete that a partially-applied
`WHERE` clause turns into zero rows) **succeeds**. A guard that can be bypassed by
being *less* specific is not a guard.

`veritymem.reject_event_delete()` is therefore a `FOR EACH STATEMENT` trigger,
which always fires, regardless of how many rows the statement would have matched.
`migrations/0004_event_delete_guard.sql` states this in the migration header.

Verified against the live database as the application role:

```
DELETE FROM events WHERE tenant_id = gen_random_uuid()
  -> ERROR: events are append-only: DELETE is not permitted (statement-level guard)
```

Note the interaction with RLS that makes this ordering matter: `events` has a
`WITH CHECK` policy, so an `UPDATE` by an under-privileged caller matches **zero
rows** and returns `rowCount: 0` silently rather than raising. That is why the
append-only guarantee needs both layers — the trigger catches the privileged path,
the policy catches the unprivileged one. This is asserted by the test *"leaves the
application role with no way to mutate a payload at all"*
(`packages/ledger/src/ledger.test.ts`).

### 3.2 What `reject_event_mutation()` actually permits

Exactly one mutation: retention redaction. It is permitted only when all of the
following hold:

- `NEW.redacted_at IS NOT NULL`
- `NEW.payload IS NULL` **and** `NEW.payload_ref IS NULL`

Any other change to `payload`, `payload_ref` or `redacted_at` raises. Separately,
a whitelist of immutable columns raises on any change: `event_id`, `stream_id`,
`seq`, `tenant_id`, `scope_id`, `origin`, `actor_id`, `occurred_at`, `recorded_at`,
`content_hash`, `prev_hash`, `byte_length`.

`chained`, `link_hash`, `sensitivity`, `idempotency_key` and `media_type` are **not**
in that list and are therefore mutable by a direct `UPDATE`. See §9.

### 3.3 The payload invariant

```sql
CONSTRAINT events_payload_present CHECK (
  (payload IS NOT NULL AND payload_ref IS NULL)
  OR (payload IS NULL AND payload_ref IS NOT NULL)
  OR redacted_at IS NOT NULL
)
```

Exactly one payload holding place, unless the row was redacted. Both set, or
neither on an unredacted row, is a constraint violation.

---

## 4. Bi-temporal columns and `valid_range`

`claims` carries both time axes explicitly:

| Column | Axis | Meaning |
| --- | --- | --- |
| `valid_from TIMESTAMPTZ NOT NULL` | valid time | When the proposition became true in the world |
| `valid_to TIMESTAMPTZ` | valid time | When it stopped being true; `NULL` = currently believed |
| `recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()` | transaction time | When the system came to believe it |
| `expires_at TIMESTAMPTZ` | policy | When the claim stops being usable regardless of validity |

`valid_from` is set by `CommitGate.resolveValidFrom()`, which reads
`events.occurred_at` for the originating event. A claim extracted today from a
two-year-old document is two years old. `valid_to` is set to the gate's clock when
a claim is superseded or revoked.

```sql
-- Maintained by trigger so the valid-time interval can never drift from the
-- columns. [) semantics: valid_to is exclusive.
valid_range TSTZRANGE GENERATED ALWAYS AS (tstzrange(valid_from, valid_to, '[)')) STORED,
CHECK (valid_to IS NULL OR valid_to > valid_from)
```

`valid_range` is a **stored generated column** (`is_generated = 'ALWAYS'`,
`generation_expression = tstzrange(valid_from, valid_to, '[)'::text)`), indexed with
GiST:

```sql
CREATE INDEX claims_valid_gist ON claims USING GIST (valid_range);
```

Note the column comment says "Maintained by trigger"; it is in fact a generated
column. The effect is the same and the drift it prevents is the same, but the
comment is wrong and a reader should not go looking for the trigger.

### 4.1 The three time modes

Implemented in `timePredicate()` (`packages/claims/src/index.ts`):

| Mode | Predicate |
| --- | --- |
| `current` | `c.valid_to IS NULL AND c.status = 'accepted'` |
| `as_of: T` | `c.recorded_at <= T AND (c.valid_to IS NULL OR c.valid_to > T) AND c.status IN ('accepted','superseded','expired')` |
| `during: [T1,T2]` | `c.valid_range && tstzrange(T1, T2, '[)')` |

`as_of` reads **transaction time** (`recorded_at`), not valid time. That is the
whole point: *"what did the system believe on the 3rd"* is a question about the
system, and answering it from the valid-time columns produces a plausible and wrong
answer. The module doc in `packages/claims/src/index.ts` says so explicitly.

`during` deliberately includes `superseded` claims, so an operator sees the belief
history rather than only the winner.

### 4.2 Indexes that make the time modes work

| Index | Definition | Serves |
| --- | --- | --- |
| `claims_current_idx` | `ON claims (tenant_id, subject, predicate) WHERE valid_to IS NULL AND status = 'accepted'` | `current` |
| `claims_valid_gist` | `USING GIST (valid_range)` | `during` |
| `claims_recorded_idx` | `ON claims (tenant_id, recorded_at)` | `as_of` |
| `claims_status_idx` | `ON claims (tenant_id, status, kind)` | lifecycle scans |
| `claims_object_gin` | `USING GIN (object jsonb_path_ops)` | object predicates |
| `claims_tsv_gin` | `USING GIN (search_tsv)` | lexical channel |
| `claims_event_idx` | `ON claims (origin_event_id)` | provenance |

---

## 5. Scopes and purpose

```sql
CREATE TABLE scopes (
  scope_id   UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL,
  project    TEXT,
  user_id    TEXT,
  agent_id   TEXT,
  session_id TEXT,
  purpose    TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scopes_must_bind_something CHECK (
    project IS NOT NULL OR user_id IS NOT NULL
    OR agent_id IS NOT NULL OR session_id IS NOT NULL
  )
);
CREATE INDEX scopes_lookup_idx ON scopes (tenant_id, project, user_id, agent_id, session_id);
```

Two separate guarantees:

- **A scope must bind at least one dimension** (`scopes_must_bind_something`). A
  scope with no dimension is a tenant-wide scope in disguise.
- **A scope must declare at least one purpose**, enforced by
  `veritymem.assert_purposes()`, called from `veritymem.ensure_scope()`. The column
  default of `'{}'` is a schema artefact; **no scope created through the API can
  have an empty purpose array**, because the only creation path is the
  `SECURITY DEFINER` function and it raises.

`scopes` deliberately has **no RLS policy and no `ENABLE ROW LEVEL SECURITY`**.
Creating an ownership boundary is a privileged act, so creation goes through
`veritymem.ensure_scope(...)`, which is `SECURITY DEFINER` with
`SET search_path = pg_catalog, public`. The consequence of the missing policy is
discussed in `docs/threat-model.md`; it is a real exposure.

Purpose arrays are sorted and de-duplicated on every write, in two independent
places: `Ledger.ensureScope()` in TypeScript and `veritymem.ensure_scope()` in SQL.
Two writes differing only in purpose order resolve to the same scope rather than
fragmenting the boundary.

### 5.1 Querying scope

```sql
-- Every scope for a tenant, with the purposes it was admitted for
SELECT scope_id, project, user_id, agent_id, session_id, purpose
  FROM scopes
 WHERE tenant_id = $1
 ORDER BY created_at;

-- Full scope context for a claim
SELECT c.claim_id, c.status, c.kind, c.subject, c.predicate, c.object,
       c.valid_from, c.valid_to, c.recorded_at, c.expires_at,
       s.project, s.user_id, s.agent_id, s.session_id, s.purpose
  FROM claims c
  JOIN scopes s ON s.scope_id = c.scope_id
 WHERE c.claim_id = $1;
```

The application role can run neither of these without a request context bound —
`veritymem.current_tenant_id()` returns `NULL` and every policy denies for the two
RLS tables involved. The first query, however, is against `scopes` itself, which has
**no RLS at all** and therefore returns every tenant's rows regardless of context.

### 5.2 `migrations/0007_scope_contains.sql` changes the containment rule

Read this before applying pending migrations: **`0007` is not a refactor. It
narrows the containment relation and adds an axis of isolation the earlier
migrations did not have.**

`0007` introduces a standalone directional predicate,
`veritymem.scope_contains(p_outer, p_inner)`, and rewrites
`veritymem.scope_reachable()` to delegate to it. The new rule, per dimension
(`project`, `user_id`, `agent_id`, `session_id`), is:

| `outer` (the caller's scope) | `inner` (the row's scope) | Reached? |
| --- | --- | --- |
| binds nothing | anything | Yes — unrestricted on that dimension |
| binds a value | same value | Yes |
| binds a value | binds nothing | **No** |
| binds a value | a different value | No |

And tenant must always match. `scope_contains` is implemented as
`o.<dim> IS NOT DISTINCT FROM i.<dim>` for all four dimensions plus
`o.tenant_id = i.tenant_id`.

The consequences, which the migration's own header and self-check state explicitly:

- **The relation is asymmetric and not a set-theoretic subset.** A scope bound only
  to a user is *not* project-restricted, so it reaches that user's claims in every
  project — but it can never reach a project-wide scope.
- **A user-bound scope no longer reaches the project-wide scope it sits inside.**
  The self-check asserts this directly:
  ```sql
  IF veritymem.scope_contains(v_narrow, v_wide) THEN
    RAISE EXCEPTION 'self-check failed: a user-bound scope reached the project scope it sits in';
  END IF;
  ```
  This is the axis of isolation `0006` did not have. Under `0006`, a user-scoped
  caller *did* reach the project-wide scope containing it, because the dimension test
  was `(caller IS NULL OR row IS NULL OR caller = row)` and the row's `NULL` project
  made it a wildcard.
- **The planner can now compute reach in one query**, because the relation is a
  predicate rather than a transitive closure.

#### Status at the time of writing

`0007` is in the repository and **has not been recorded as applied**:

```
schema_migrations: 0001_core.sql … 0006_scope_reach_predicate.sql
```

The running database still executes the `0006` rule. Verified directly against it,
with the app role, using scopes constructed for the purpose:

| Call | Observed (live, `0006` rule) | `0007` rule would give |
| --- | --- | --- |
| `scope_contains(wide project, narrow project+user)` | `true` | `true` |
| `scope_contains(narrow project+user, wide project)` | **`true`** | **`false`** |
| `scope_contains(user-only user, narrow project+user)` | `true` | `true` |
| `scope_contains(narrow project+user, user-only user)` | **`true`** | **`false`** |
| `scope_contains(narrow alice, narrow bob)` | `false` | `false` |
| `scope_contains(wide project, narrow bob)` | `true` | `true` |

So `veritymem.scope_contains` and `veritymem.scope_reachable` exist in the database
with `0007`'s bodies, while the RLS policies still route through
`row_authorized` → the `0006`-era dimension tests. **The two disagree on two of the
six cases above**, which is exactly the condition ADR 0005 was written to prevent:
one rule, in one place.

**What an operator should do.** Apply `0007` deliberately, not as a side effect of
`pnpm migrate`, and treat it as a behaviour change:

1. Measure the affected read paths before and after. Any caller whose scope binds a
   dimension that a row's scope leaves unbound will lose reach.
2. Expect legitimate retrieval loss, particularly for a caller bound at user level
   reading project-level claims. That is the intended narrowing, and it is a recall
   change rather than a leak — the safe direction — but it will look like data
   disappearing.
3. Re-run the authorization suite. `packages/retrieval/src/pipeline.test.ts` has
   behavioural assertions that depend on which rule is in force.
4. Update this document and `docs/threat-model.md`: the containment table in
   `docs/threat-model.md` §2/A4 describes the `0006` rule.

Until `0007` is applied and the planner and policies are confirmed to use one rule
again, **describe the system as having a pending authorization-semantics change**,
not as having one containment rule.

---

## 6. The outbox

```sql
CREATE TABLE outbox (
  outbox_id    BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 8,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by    TEXT,
  locked_at    TIMESTAMPTZ,
  last_error   TEXT,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox (available_at, outbox_id) WHERE completed_at IS NULL;
```

The outbox lives in the same database as the ledger, because the ledger is already
an event source and a second broker would be a second source of truth.

Two message kinds are written by this repository:

| Kind | Written by | Payload |
| --- | --- | --- |
| `extract.event` | `Ledger.append()`, in the same transaction as the event insert | `{event_id, tenant, tenant_id, scope_id, chain_input}` |
| `project.claim` | `IngestPipeline.enqueueProjection()`, only when `GateResult.claim_id !== null` | `{claim_id, tenant_id, scope_id, decision_id}` |

The acknowledgement and the commitment to extract cannot diverge, because they are
the same commit.

`OutboxWorker.claim()` uses `SELECT ... FOR UPDATE SKIP LOCKED` inside an `UPDATE
... WHERE outbox_id IN (...)`, so N workers scale out without a coordination
service. Each processor runs inside `Db.withRequest()` bound to the message's
tenant, with `scopeIds: []` and `purposes: []` — meaning **row-level security
denies that worker every tenant row**. That is safe for a worker that only needs
the message payload, and it is a real constraint on any future processor that
needs to read the rows it is processing.

Retry is exponential with a ceiling: `backoffSeconds = min(300, 2 ** min(attempts, 8))`.
A message that exhausts `max_attempts` stops being claimable and sits with its
`last_error` recorded.

```sql
-- Projection lag, in one query
SELECT kind, count(*) AS pending, min(available_at) AS oldest
  FROM outbox
 WHERE completed_at IS NULL
 GROUP BY kind;

-- Poison messages
SELECT outbox_id, kind, attempts, left(last_error, 200) AS error
  FROM outbox
 WHERE completed_at IS NULL AND attempts >= max_attempts;
```

`outbox` has **no RLS** and the application role can read all of it (verified: 642
rows visible with no request context bound). Its payload contains tenant ids,
event ids and scope ids but no event content. See `docs/threat-model.md`.

---

## 7. Projections and rebuild

### 7.1 What exists

| Projection | Storage | Maintained by |
| --- | --- | --- |
| Lexical | `claims.search_tsv TSVECTOR` + `claims_tsv_gin` | Trigger `claims_search_tsv` → `veritymem.claim_search_document(subject, predicate, object)` |
| Dense | `claim_embeddings (claim_id, tenant_id, embedding VECTOR(1024), model_id)` + HNSW | `projectClaim()` in `packages/retrieval/src/projections.ts` |
| Entity | `entity_aliases (tenant_id, alias, canonical, source, confidence)` | `projectEntities()`, same file |
| Temporal | `claims.valid_range` + `claims_valid_gist` | Generated column, so always consistent |
| Relation | `claim_relations` + recursive CTEs | Written by `CommitGate.insertClaim()` and `claims.createRelation()` |

`claim_search_document()` is `IMMUTABLE` and uses
`to_tsvector('english'::regconfig, subject || ' ' || predicate) ||
jsonb_to_tsvector('english'::regconfig, object, '["string","numeric","boolean"]'::jsonb)`.
It is a trigger rather than a generated column because `jsonb_to_tsvector` is not
immutable.

The HNSW index uses `vector_cosine_ops` with `m = 16, ef_construction = 64`. HNSW
is chosen over IVFFlat because the corpus grows continuously and IVFFlat needs a
training pass that a rebuild-heavy projection cannot rely on.

**Only accepted and disputed claims are projected.** `projectClaim()` re-reads the
claim's status and, for anything else, calls `deindexClaim()` to remove any prior
vector rather than leaving a stale one: *"a claim that was accepted and has since
been revoked must stop being a retrieval candidate, and leaving a stale vector in
place would make revocation cosmetic."* The same function is the only writer of
`projection_versions`, inserting or advancing the `dense` row with
`code_version = PROJECTION_CODE_VERSION` (`"projections@1"`) and
`ledger_watermark = max(events.seq)` for the tenant.

Two functions compute digests for replay comparison:
`rebuildProjections()` (dense + entity, with a truncate-then-reproject path) and
`digestLexicalProjection()` (the trigger-maintained `search_tsv`, read back rather
than recomputed). Both return `{digest, rows}` over a canonicalised row stream.

**Two caveats on the dense and entity projections.**

1. **The outbox processor for `project.claim` cannot see the claim it projects.**
   `OutboxWorker.runOnce()` binds `scopeIds: []` and `purposes: []`, so
   `veritymem.row_authorized()` denies the read and `projectClaim()` returns
   `{projected: false, reason: "claim not found"}`. The processor treats that as a
   non-error and the message completes. Verified against the live database. See
   `docs/threat-model.md` §6.1. `rebuildProjections()` runs under a caller-supplied
   context and therefore does populate the projections; the worker path does not.
2. **Nothing calls `deindexClaim()` on revocation.** `claims.applyStatus()` updates
   `claims.status` and does not touch `claim_embeddings`, and no outbox message is
   enqueued for a status change. A revoked claim keeps its vector until something
   re-projects it.

Entity aliases are **never deleted**. `deindexClaim()` deliberately leaves them,
because an alias is many-to-many and deleting on one claim's revocation would break
the other claims that still rely on it. Alias garbage collection is deferred to a
rebuild-time concern with a reference count, which does not exist, so an alias
survives the revocation of every claim that wrote it.

### 7.2 Rebuild and drift tracking

```sql
CREATE TABLE projection_versions (
  projection       TEXT PRIMARY KEY,
  code_version     TEXT NOT NULL,
  model_version    TEXT,
  model_sha256     TEXT,
  prompt_version   TEXT,
  ledger_watermark BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The specification's version of this table lacks `model_sha256`; it is present here
specifically so a gate-model swap is a recorded, replayable event rather than a
silent behavioural change (see `docs/adr/0006`).

```sql
CREATE TABLE query_traces (
  trace_id              UUID PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  caller                TEXT NOT NULL,
  query                 JSONB NOT NULL,
  policy_version        TEXT NOT NULL,
  resolved_scope_ids    UUID[] NOT NULL,
  candidates            JSONB NOT NULL,
  returned              JSONB NOT NULL,
  projection_watermark  BIGINT NOT NULL,
  model_calls           INT NOT NULL DEFAULT 0,
  latency_ms            INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`resolved_scope_ids` and `model_calls` are not in the specification's version.
`model_calls` exists so a trace proves the zero-LLM-read commitment per query
rather than asserting it (see `docs/adr/0008`).

Both tables now have writers. `query_traces` is written by `writeTrace()` in
`packages/retrieval/src/compose.ts`, which records the plan (`text`, `purpose`,
`action_risk`, `time`, `scope_resolution`, per-channel `ran`/`hits`/`note`/`duration_ms`),
the fused candidate set (capped at 50) and the returned set — that is what makes
"why did the system return this" answerable after the fact. `projection_versions` is
written by `projectClaim()`.

**No `/v1/replay` implementation exists.** `ProjectionDigestSchema` and
`ReplayResponseSchema` are in `packages/contracts/src/claim.ts`;
`rebuildProjections()` and `digestLexicalProjection()` compute the digests they need;
`projectionDigest(rows)` in `packages/ledger/src/blobs.ts` is an unused duplicate of
the private `digestRows()` in `projections.ts`; and nothing compares a before/after
digest or exposes the result. Replay equality is measurable but not yet measured.

`projection_versions` and `entity_aliases` have **no RLS** and are globally
readable by the application role. `entity_aliases` in particular means alias strings
written by one tenant are readable by another; `projectEntities()` never merges
aliases across tenants in the rows it writes, but the table itself is global.

---

## 8. Retention and redaction semantics

### 8.1 What the specification requires

A delete produces a manifest and scrubs ledger payloads, blobs, vectors, FTS rows
and caches per retention policy. Deletion is proven by **residual-match scan**, and
a job reports `verified` only when `residual_matches` is `0`.

### 8.2 What the schema supports

```sql
CREATE TABLE retention_jobs (
  job_id           UUID PRIMARY KEY,
  tenant_id        UUID NOT NULL,
  subject_or_scope JSONB NOT NULL,
  mode             retention_mode NOT NULL,   -- 'erase' | 'redact' | 'export_then_erase'
  reason           TEXT NOT NULL,
  status           retention_state NOT NULL DEFAULT 'pending',  -- 'pending'|'running'|'scanning'|'verified'|'failed'
  stores_touched   TEXT[] NOT NULL DEFAULT '{}',
  manifest         JSONB NOT NULL DEFAULT '{}'::jsonb,
  residual_matches INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at      TIMESTAMPTZ
);
```

The redaction path is fully built at the storage layer and is the **only** permitted
mutation to an `events` row:

| Step | Effect |
| --- | --- |
| `UPDATE events SET payload = NULL, payload_ref = NULL, redacted_at = now()` | Permitted; the other two payload mutation shapes raise |
| `content_hash`, `prev_hash`, `link_hash` | Preserved — the chain still verifies after redaction |
| Row existence | Preserved — the system can still testify the event existed and when |
| `evidence_spans` rows | Preserved; `Ledger.verifySpan()` returns `{status: "redacted"}` thereafter, mapping to `span.event_redacted` |
| `claims` referencing redacted spans | Preserved; `evaluateUse()` returns `deny` with `span.unresolvable` when `digest_ok` is false |
| `Ledger.writeSpan()` against a redacted event | Refuses with `LedgerError("invalid_span", "event ... has been redacted; no new span may reference it")` |

The retention configuration surface is `RETENTION_LEDGER_MODE=redact|erase`,
read into `Env.retention.ledgerMode` by `loadEnv()`.

### 8.3 What is implemented

Retention is implemented in `packages/retrieval/src/retention.ts` — `forget()`,
which runs two phases and reports success only from the second.

**Phase 1 — scrub.** `runForget()` identifies affected events and claims by subject
and scope dimensions, then redacts:

```sql
UPDATE events
   SET payload = NULL, payload_ref = NULL, redacted_at = COALESCE(redacted_at, now())
 WHERE event_id = ANY($1::uuid[]) AND (payload IS NOT NULL OR payload_ref IS NOT NULL)
```

That is precisely the mutation `veritymem.reject_event_mutation()` permits. It also
deindexes the affected claims from the dense projection via `deindexClaim()`, and
scans `RETENTION_STORES` — `events.payload`, `events.blobs`, `claims`,
`claim_evidence`, `claim_embeddings`, `entity_aliases`, `query_traces`.

**Phase 2 — residual scan.** Every declared store is scanned for surviving copies of
the subject. The job's status is `verified` only when the total is zero:

```ts
status: outcome.residual_matches === 0 ? "verified" : "failed",
verified_at: outcome.residual_matches === 0 ? outcome.completed_at : null,
```

A non-zero residual count is written into `retention_jobs.residual_matches` with a
per-store breakdown in `manifest.residual_scan`, and the code comments say why: *"a
non-zero residual count means the job is not verified; the surviving rows are named
per store"*. All four `retention.*` reason codes are emitted.

`recordJob()` writes `retention_jobs`, so a forget request leaves a durable record of
what it touched and what survived.

**The caveat that matters: retention runs under a binding that denies every row, so
`forget()` currently reports success while changing nothing.**

`forget()` opens its transaction with empty scopes and purposes:

```ts
const outcome = await dependencies.db.withRequest(
  {
    tenant: request.tenant_id,
    principal: `retention:${request.reason}`,
    // Retention runs with the caller's own scope set empty: it operates on the
    // tenant, and the rows it touches are selected by subject rather than by
    // reachable scope. That is why it is an admin-audience endpoint.
    scopeIds: [],
    purposes: [],
    action: "retention:forget",
  },
  async (executor) => runForget(dependencies, executor, request, mode, jobId, startedAt),
);
```

The reasoning is stated, but the mechanism does not do what the comment assumes.
`veritymem.row_authorized()` returns `FALSE` whenever the bound purpose set is
empty, for **every** row including the caller's own tenant. Verified against the
live database as `veritymem_app`, inside a transaction bound exactly as `forget()`
binds it, with one real event present in that tenant:

| Statement | `runForget` expectation | Observed |
| --- | --- | --- |
| `affectedEvents` identification query | the tenant's matching events | `rowCount: 0` |
| `affectedClaims` identification query | the tenant's matching claims | `rowCount: 0` |
| `UPDATE events SET payload = NULL, payload_ref = NULL, redacted_at = …` | redact them | `rowCount: 0` |
| `SELECT (payload IS NULL) FROM events WHERE event_id = $1` | `true` after redaction | `rowCount: 0` — the row is not visible to confirm |
| residual scan `events.payload` | `0` after a successful erase | `0` |

The last row is the problem. The residual scan is a `count(*)` over rows the same
binding cannot see, so it returns zero for the same reason the scrub matched
nothing — and zero is precisely the signal `forget()` interprets as proof:

```ts
status: outcome.residual_matches === 0 ? "verified" : "failed",
verified_at: outcome.residual_matches === 0 ? outcome.completed_at : null,
```

**A forget that redacts nothing reports `verified`.** That is the worst available
failure mode for this feature: the specification's entire position on deletion is
that it is proven by scan rather than assumed, and a scan that cannot see the data
proves nothing at all. Every store reports `rows_affected: 0`, no error is raised,
and a `retention_jobs` row records a clean, verified deletion.

The unit test *"erases a subject's payload and proves it with a residual scan"*
passes because it calls `forget()` through a harness whose `Db` is already bound to
the tenant and scope — so the test exercises a different request context from the
one `forget()` creates for itself. The defect is real in production and invisible to
that test.

The fix is not a patch to the predicate. Retention is an administrative operation on
a whole tenant and needs an explicit privileged path — a `SECURITY DEFINER`
function, or a scope set resolved from the tenant rather than left empty — and the
residual scan needs a way to distinguish "no matches" from "could not look". See
`docs/threat-model.md` §6.1, which records the same class of bug in the outbox
worker.

The redaction mechanism itself is correct and unchanged at the schema level. A
direct check on the live database confirms that an accepted claim can legally move
to `revoked`, that the `claims_check` constraint
(`valid_to IS NULL OR valid_to > valid_from`) holds for the resulting row, and that
the append-only trigger permits exactly the payload-clearing `UPDATE` above. The
defect is entirely in the request context `forget()` opens for itself, not in the
storage layer.

The retention configuration surface is `RETENTION_LEDGER_MODE=redact|erase`, read
into `Env.retention.ledgerMode` by `loadEnv()`. **`forget()` does not read it** — the
mode comes from the request, defaulting to `redact`. The environment variable is
therefore inert.

### 8.4 Blob erasure

`events.blobs` is named in `RETENTION_STORES` and is included in the residual scan,
but `packages/ledger/src/blobs.ts` has no delete path:

> *"Evidence bytes are write-once, read-many, and addressed by their own SHA-256, so
> there is no update path and no delete path here: retention erasure mutates the
> ledger row, and blob reclamation is a separate operator task."*

So an event whose payload was stored out of line keeps its bytes in the blob store
after redaction. The ledger row no longer references them, and the blob is
unreachable through the API — but it is still on disk, and it is still a surviving
copy of the subject's content. **Deletion across the blob store is not proven.** See
`docs/threat-model.md` §5.4.

---

## 9. Known schema-level gaps

These are stated here because a reader querying the database would otherwise
discover them by surprise. Each was verified directly.

| Gap | Evidence | Impact |
| --- | --- | --- |
| `claims.scope_id` is mutable | `veritymem.enforce_claim_transition()` does not list `scope_id`; a direct `UPDATE claims SET scope_id = $2` succeeded as the application role | A caller holding two scopes can move a claim between them, changing who can retrieve it |
| `claims.object` is mutable | Same trigger; `UPDATE claims SET object = '{"window":"attacker-chosen"}'` succeeded, and `search_tsv` followed the change via `claims_search_tsv` | A claim's proposition can be rewritten after promotion without a new decision row |
| `claims.authority` and `valid_from` are mutable | Same trigger; both `UPDATE`s succeeded | `verified_record` can be asserted on a claim the gate admitted as `observation`; a claim's valid time can be back-dated |
| The application role can `INSERT` an `accepted` claim directly | Verified: a bare `INSERT INTO claims (..., status, ...) VALUES (..., 'accepted', ...)` under a valid request context returned a row | "No model call sets `status = accepted`" holds at the language level (extractors return `Proposal`, which has no status field) but not at the privilege level. A compromised agent session that can reach Postgres can promote beliefs |
| `scopes`, `outbox`, `entity_aliases`, `projection_versions`, `principals`, `streams`, `tenants` have no RLS | `pg_class.relrowsecurity = false` for all seven | Any connection with the application credential reads all tenants' scope metadata and the full outbox |
| No `claim_evidence` delete guard | No trigger on `claim_evidence`; a `DELETE` is blocked only because no RLS policy admits it | With a privileged connection, a claim's evidence binding can be removed |
| `decisions` has no delete guard | Same | A promotion act's record can be removed with a privileged connection |
| `evidence_spans.selector` is stored but never interpreted | `grep -rn "selector" --include="*.ts" packages/` returns only plumbing | Structured payloads cite byte ranges of their serialised text |
| `RETENTION_LEDGER_MODE` is parsed and unused | `loadEnv()` reads it into `Env.retention.ledgerMode`; `retention.forget()` takes the mode from the request and defaults to `"redact"` | The configured mode has no effect |
| `GATE_THRESHOLDS.lexicalEntailmentFloor` is now consumed by tests, not by the gate | `pipeline.test.ts` constructs `new LexicalEntailmentBackend({ floor: DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor })`; `LexicalEntailmentBackend` itself still defaults `floor ?? 0.6`, and no production path constructs it | Tuning the constant in `policy.ts` changes test behaviour and nothing else |
| `GATE_CONFIDENCE_THRESHOLD` is parsed and unused | `loadEnv()` reads it into `Env.gate.confidenceThreshold`; the gate reads `DEFAULT_COMMIT_POLICY.thresholds.entailmentFloor` (0.5) instead | The environment variable does not change gate behaviour |
| `GATE_ENTAILMENT_BACKEND` is parsed and unused | `loadEnv()` reads it into `Env.gate.backend`; nothing constructs a backend from it | The backend actually used is whatever the (absent) server wires up |
| `EMBEDDING_BACKEND`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_MODEL_ID` are parsed and unused | `loadEnv()` reads them into `Env.embedding`; `HashEmbeddingBackend` is constructed with literal defaults wherever it is used | No hosted embedder is reachable through configuration |
| `veritymem.current_principal_id()` and `veritymem.current_action()` are never called | Only their `CREATE OR REPLACE` sites | The `action` label is set on every request and read by no policy |
| `FROM`/`TO` bind in `timePredicate()` for a non-`during` mode | `listClaims()` sets `values.FROM`/`values.TO` to `now` and the `hydrate()` helper only substitutes placeholders present in the SQL | Harmless today; the placeholders are unused in `current`/`as_of` |

---

## 10. Enum reference

These mirror the Postgres types one-for-one; a divergence between a TypeScript
union and a database enum is a runtime error waiting for the least convenient
moment (`packages/contracts/src/primitives.ts`).

```sql
CREATE TYPE origin_kind       AS ENUM ('user','agent','tool','document','database','model_inference');
CREATE TYPE authority_cls     AS ENUM ('verified_record','observation','user_self_report','hearsay','inference');
CREATE TYPE claim_status      AS ENUM ('proposed','accepted','disputed','superseded','rejected','revoked','expired');
CREATE TYPE claim_kind        AS ENUM ('observation','user_self_report','preference','event','decision',
                                       'plan','hypothesis','procedure','permission','derived_summary');
CREATE TYPE decision_outcome  AS ENUM ('accept','accept_limited_scope','needs_review','quarantine','reject','revoke');
CREATE TYPE relation_kind     AS ENUM ('duplicates','narrows','contradicts','supersedes','derived_from');
CREATE TYPE evidence_role     AS ENUM ('supports','refutes');
CREATE TYPE candidate_state   AS ENUM ('pending','extracted','validated','gated','failed');
CREATE TYPE retention_mode    AS ENUM ('erase','redact','export_then_erase');
CREATE TYPE retention_state   AS ENUM ('pending','running','scanning','verified','failed');
```

Two further closed vocabularies live in TypeScript only, with no database enum:

- `sensitivity` — `normal` | `private` | `high`, stored as free `TEXT NOT NULL
  DEFAULT 'normal'` on `events` with no `CHECK`. **A typo is accepted.**
- `use` decision — `use` | `verify` | `clarify` | `deny`, never stored; it is
  computed per read by `evaluateUse()` in `packages/claims/src/index.ts`.

### 10.1 Enum-to-kind mapping caveat

`QUARANTINE_KINDS` in `packages/contracts/src/policy.ts` is
`["procedure", "permission"]`. The reason-code help text for
`kind.requires_review` reads *"The claim kind is identity, permission, money,
safety or executable procedure, which requires a human."*

`claim_kind` has no `identity`, `money` or `safety` member, and the gate's
quarantine test is `this.policy.quarantineKinds.includes(candidate.kind)`, which
matches only `procedure` and `permission`. **The reason-code text overstates what
the gate enforces**: a `user_self_report` asserting an identity or a monetary
amount is not quarantined by kind. See the threat table in
`docs/threat-model.md`.

---

## 11. Index and constraint inventory

| Table | Index / constraint | Purpose |
| --- | --- | --- |
| `events` | `UNIQUE (tenant_id, stream_id, seq)` | Stream ordering |
| `events` | `UNIQUE (tenant_id, idempotency_key)` | Idempotency per tenant |
| `events` | `events_stream_idx`, `events_recorded_idx`, `events_scope_idx`, `events_actor_idx` | Replay, bi-temporal, authz, actor scans |
| `evidence_spans` | `evidence_spans_identity_idx` (unique) | Span idempotency |
| `claim_candidates` | `claim_candidates_event_idx`, `_state_idx`, `_lookup_idx` | Reprocessing, queue, subject/predicate lookup |
| `claims` | seven indexes, listed in §4.2 | |
| `claim_relations` | `PRIMARY KEY (from_claim, to_claim, rel)`, `CHECK (from_claim <> to_claim)`, `claim_relations_to_idx` | No self-relations; reverse traversal |
| `decisions` | `CHECK (candidate_id IS NOT NULL OR claim_id IS NOT NULL)`, `decisions_reasons_gin` | A decision must be about something; reason codes are queryable because they drive the review-burden metric |
| `outbox` | `outbox_pending_idx` (partial, `WHERE completed_at IS NULL`) | Claim loop |

### 11.1 The review-burden query

`decisions_reasons_gin` exists for one metric. The specification's 2% ceiling is a
product-failure threshold, and it is computable from this table:

```sql
-- Review burden over a window, per tenant
SELECT tenant_id,
       count(*) FILTER (WHERE outcome IN ('needs_review','quarantine'))::numeric
         / NULLIF(count(*), 0) AS review_burden,
       count(*) AS decisions
  FROM decisions
 WHERE decided_at >= now() - interval '7 days'
 GROUP BY tenant_id;

-- Why review is happening, by reason code
SELECT reason_code, count(*)
  FROM decisions, unnest(reason_codes) AS reason_code
 WHERE outcome IN ('needs_review','quarantine')
   AND decided_at >= now() - interval '7 days'
 GROUP BY reason_code
 ORDER BY 2 DESC;
```

---

## 12. Verification note

Every enforcement claim in this document was checked against a running PostgreSQL
17 + pgvector instance on `127.0.0.1:55432`, as the `veritymem_app` role
(`rolsuper = false`, `rolbypassrls = false`), using:

- `pg_policies` for the ten policy expressions and their exact `qual` / `with_check` text;
- `pg_class.relrowsecurity` for the seventeen tenant-adjacent tables, ten of which have it enabled;
- `pg_trigger` joined to `pg_proc` for the six application triggers and their `tgtype` values (`10` = `BEFORE DELETE FOR EACH STATEMENT`, `11` = `BEFORE DELETE FOR EACH ROW`, `19` = `BEFORE UPDATE FOR EACH ROW`, `23` = `BEFORE INSERT OR UPDATE ... FOR EACH ROW`, `27` = `BEFORE UPDATE OR DELETE FOR EACH ROW`);
- `information_schema.columns` for the generated-column expression on `claims.valid_range`;
- `pg_constraint` for the `claims` check constraints;
- direct transactional probes for the mutability, gate-bypass, worker-visibility and
  retention-visibility claims in §7, §8 and §9 — each wrapped in `BEGIN`/`ROLLBACK`
  so nothing was left behind.

### 12.1 Test suite state

`pnpm test` against the same instance currently reports **60 tests, 51 pass, 9
fail**. The failures are in `packages/retrieval/src/pipeline.test.ts` (a new file
under active development) and one is worth recording here because it is a data-model
observation rather than a retrieval bug:

**`seededIds()` produces colliding identifiers against a persistent ledger.**
`packages/testkit/src/helpers.ts` builds each test context with
`seededIds(\`${label}-${randomUUID().slice(0, 8)}\`)`, which is fresh per run. But the
*"tenant and purpose isolation at the database"* block constructs its ledger
directly:

```ts
ids: seededIds("isolation"),
```

A fixed seed means the same `evt_…` identifiers on every run. Because `events` is
append-only and the test suite never deletes rows — by design, per
`AGENT-BRIEF.md`, *"a suite that can delete events is testing a different system
than the one that ships"* — the second run against the same database fails with:

```
code: '23505', table: 'events', constraint: 'events_pkey'
```

This is the append-only property doing exactly what it is supposed to do, and it is
a good demonstration of it: a deterministic identifier generator plus an
undeletable table means the test is only runnable once per database. The fix is a
fresh seed per context, as `createTestContext()` already does.

The other nine failures are behavioural assertions in the retrieval tests
(`expected all accepts, saw needs_review` and similar), and are outside the scope of
this document.

**There are no tests for `packages/gate`, `packages/claims`,
`packages/model-adapters` or `packages/ledgerbench` as standalone units.** The
retrieval suite exercises the gate and the pipeline end to end through
`pipeline.test.ts`.
