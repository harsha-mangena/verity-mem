# VM-A1 — fresh-database migration and RLS semantics: evidence

This records what was executed to close VM-A1 in
`docs/remaining-implementation-plan.md`, so a reviewer can check the claims rather
than take them on trust. It is evidence, not a plan.

VM-A1 is the prerequisite for VM-A2 (existing-database upgrade rehearsal) and VM-A3
(channel-level plan capture). **It proves correctness. It does not prove that the
latency target is met** — no million-claim performance claim is made here, and the
benchmark step of the acceptance script was left disabled.

## Environment

| | |
| --- | --- |
| PostgreSQL | 17.11 (Debian 17.11-1.pgdg13+2), aarch64 |
| pgvector | 0.8.6 |
| pg_trgm | 1.6 |
| pg_stat_statements | 1.11 |
| Node | v24.18.0 |
| pnpm | 9.15.9 |
| Container | `deploy/compose/docker-compose.yml`, `127.0.0.1:55432` |

## 1. Virgin `0001` → `0015` migration

A uniquely named disposable database was created and left empty; the 24 GB
`veritymem` and 11 GB `veritymem_perf` databases were not reset, deleted or modified.
`pnpm db:reset` was not used.

```
created: veritymem_vma1_virgin_20260922_070415
```

Bootstrap applied **before** the first migration, because `CREATE EXTENSION` is a
superuser step the Compose `initdb` script performs for the reference database and
a fresh database does not inherit. This is the same set
`deploy/compose/initdb/01-extensions.sql` installs, and it is deliberately not part
of the migration chain: a migration that needs superuser rights cannot run under the
migration role on a managed database.

```
CREATE EXTENSION IF NOT EXISTS vector;           -- 0.8.6
CREATE EXTENSION IF NOT EXISTS pg_trgm;          -- 1.6
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
GRANT CONNECT ON DATABASE <db> TO veritymem_app;
GRANT USAGE   ON SCHEMA public TO veritymem_app;
```

The database was dropped and recreated before this step, so the recorded run is a
genuine replay from zero rather than a continuation of the earlier failed attempt.

### First run — all fifteen applied

```
$ pnpm migrate
applying 0001_core.sql
... (0002 … 0013)
applying 0014_precomputed_scope_reach.sql
applying 0015_claim_entity_index.sql
migrated: applied=15 already-applied=0 total=15
exit 0
```

### Second run — none pending

```
$ pnpm migrate:verify
verified: applied=0 already-applied=15 total=15
exit 0
```

### Post-migration state on the new database

```
0014 present: 1
0015 present: 1
claim_entities rows: 0        (empty database, so no backfill)
app role: super=false bypassrls=false
RLS tables: 19
```

### Proof tests against the new database

```
$ DATABASE_URL=…/$DB MIGRATION_DATABASE_URL=…/$DB \
  node --experimental-strip-types --test \
  packages/retrieval/src/postgres-proof.test.ts
tests 28   pass 28   fail 0   skipped 0
exit 0
```

Every authorization case runs as `veritymem_app`, and the first case asserts that
identity — a non-superuser with no `BYPASSRLS` — because an RLS property proved as
the owner proves nothing.

## 2. Upgraded-database path (0013 → 0015)

The same migrations were also applied to the long-lived database, which already held
three corpora. This is the upgrade a deployment performs, as distinct from the virgin
install above.

```
$ pnpm migrate
applying 0014_precomputed_scope_reach.sql
applying 0015_claim_entity_index.sql
migrated: applied=2 already-applied=13 total=15
exit 0        (46 s wall, almost all of it the 0015 backfill)
```

Backfill verification on that database:

```
accepted/disputed claims:   2,019,229
claims with ≥1 entity row:  2,019,229     (exact coverage)
orphan entity rows:         0
duplicate (tenant, canonical, claim) groups: 0
```

## 3. Acceptance ladder

| command | exit |
| --- | --- |
| `pnpm migrate:verify` | **0** — `applied=0 already-applied=15 total=15` |
| `pnpm typecheck` | **0** |
| `pnpm test` | **0** — 365 tests, 365 pass, 0 fail, 0 skipped |
| `bash scripts/verify.sh` | **1** — see below |

`scripts/verify.sh` reported **0 hard step failures**. Its own steps all passed:
Node/pnpm/Python/uv pinned and present, PostgreSQL 17.11, pgvector 0.8.6, 15
migrations applied with none pending, 19 RLS tables and 19 policies with
`app role bypassrls=f`, 365 tests, the Python harness, and the ONNX production
verifier's adversarial tests.

It exits 1 solely because the **LedgerBench release gate is red**, for the same seven
pre-existing reasons it was red before this work began:

```
- target contradiction_detection   [not_measured]  no human-authored update corpus
- target deterministic_projections [fail]          no projection rebuild was compared
- target p95_query_latency         [not_measured]  no corpus at the declared reference scale
- target reference_workload_burden [not_measured]  no ordinary deployed-agent traffic corpus
- target human_audit_set           [not_measured]  no human labels
- target external_isolation        [not_measured]  requires an independent red team
- target external_user_workload    [not_measured]  no external user run
```

Those targets need resources this environment does not have — human-authored corpora,
an external red team, a published reference machine — and they were **not** weakened
or removed to make the ladder green.

## 4. What the proof suite covers

`packages/retrieval/src/postgres-proof.test.ts`, 28 cases in three suites.

**Reach (0014).** Project scope reaching user scopes; user scope not widening to
project; purpose denial including that an empty purpose set is not a wildcard; tenant
denial; a tenant-less system context raising rather than defaulting; an unbound
connection reading no tenant rows with an owner positive control; system context
authorized by its own tenant only; the closure cleared at both `COMMIT` and
`ROLLBACK`; the closure equal to `scope_contains` — the rule RLS enforces — computed by
PostgreSQL; and pooled-connection reuse with `max: 1`, asserting an identical
`pg_backend_pid()` and an empty tenant, principal, scope set, closure, purpose set and
system flag before the next binding.

**Entity projection (0015).** Populated for every accepted or disputed claim with no
orphans and no duplicates; the projection returning the same authorized claim ids as
the pre-migration query on a golden corpus; subject strings; scalar JSON string objects
with the quoted and unquoted canonical distinguished; non-string objects; revoked
claims; superseded claims; the same alias in two tenants asserted in **both** directions;
runtime maintenance through `projectClaim` and `deindexClaim`; and RLS on
`claim_entities` itself.

**Role restrictions.** Non-superuser, no `BYPASSRLS`, no `CREATEDB`/`CREATEROLE`, no
`CREATE` on the database or the `public` schema, no table ownership — ownership would
exempt the role from its own policies, since `relforcerowsecurity` is off — while
`USAGE` on the schema is asserted true so the rest describe a restricted role rather
than an inert one. Privileges are read from the catalog rather than probed by
attempting DDL, because an attempt that succeeded would leave a schema change behind.
No privileges were modified to make any case pass.

### The one place the new reach deliberately disagrees with the old

The previous expression matched when *either* side left a dimension unbound:
`(outer.project IS NULL OR inner.project IS NULL OR outer.project = inner.project)`.
`scope_contains`, the rule the RLS policy has always used, matches when the **caller**
leaves it unbound. So the precomputed closure is the old reach *minus* the scopes that
leave free a dimension the caller binds — the widening this repository has already
fixed once, where a caller bound to one user could reach a record binding no user.

The suite asserts this as a **bounded difference computed in SQL**, not as equality.
Three earlier versions re-derived the divergent set by hand and each was wrong
differently; a test whose oracle is a second hand-written copy of the rule cannot find
a bug in that rule.

## 5. Migration and rollback implications

**0014** replaces `set_request_context`, `scope_reachable` and `row_authorized` and adds
`current_reachable_scope_ids()`. All `CREATE OR REPLACE`; no table changes, no
backfill, and it cannot fail on data. Reach is now computed once when the request
context is bound and stored in a transaction-local GUC. **Rollback:** restore the
0007/0009 function bodies. The GUCs are transaction-local and verified cleared at both
`COMMIT` and `ROLLBACK`.

**0015** is the invasive one. It creates `claim_entities`, backfills it
(3,883,576 rows on the long-lived database), builds the primary key **after** the bulk
load rather than maintaining a unique index through it, enables RLS with a policy that
references `claims`, and adds four indexes. **Rollback is not symmetric:** the backfill
and index builds are the expensive part and dropping the table discards the projection.
Measured on the long-lived database: 46 s for `0013 → 0015`.

**Neither migration is a substitute for VM-A2.** These timings come from small and
medium databases on a laptop. VM-A2 exists to rehearse the upgrade against a
production-shaped snapshot and record lock duration, WAL bytes and peak disk, and that
has not been done.

## 6. Not verified

- **No `0001 → 0015` replay on a production-shaped volume.** The virgin run is on an
  empty database and the upgrade run took `0013 → 0015` on an existing one. Neither is
  a rehearsal at production scale; that is VM-A2.
- **The extension bootstrap is manual on a fresh database.** A deployment relying on
  the migration chain alone will fail at `0001` with `type "vector" does not exist`
  unless `initdb` or an equivalent step installs the extensions first. This is expected
  and matches the Compose layout, but it is an operational prerequisite rather than
  something the migrations enforce.
- **Timing-inference isolation and privileged MCP tool surfaces** are outside VM-A1 and
  remain uncovered.
- **The entity channel's `claim_entities` projection is verified at the
  `projectClaim` boundary.** The outbox processor that calls it on a schedule is not
  exercised end to end here.
- **`/dev/shm` is 64 MB** in this Docker environment, so large parallel hash joins can
  fail with `could not share memory`. It constrained some ad-hoc diagnostics and does
  not affect the suite.
- **VM-A2, VM-A3, LAYA, Jev and ANN work were not started**, as instructed.
