# VM-A2 — migration rehearsal: usage, safety rules, and interpretation

`pnpm eval:perf migration-rehearsal` applies migrations **0014** and **0015** to a
production-shaped database while an application workload keeps running, and writes one
machine-readable report describing what the migrations cost and whether the application stayed
available.

This document is the usage guide and the interpretation guide. It is not a latency claim, and
nothing in the command measures one.

---

## 1. What this is for

Migrations 0014 and 0015 change the shape of the read and write paths:

| migration | what it does | what it changes for a running system |
| --- | --- | --- |
| `0014_precomputed_scope_reach.sql` | replaces the per-row authorization predicate with a transaction-local closure, and replaces `veritymem.set_request_context` | every read path calls a function this migration creates |
| `0015_claim_entity_index.sql` | creates `claim_entities`, backfills it from `claims`, adds its primary key, adds three tenant indexes, and enables row-level security on it | the entity channel and the projection write path both require a table this migration creates inside its own transaction |

Both are therefore *correctness* changes with *availability* consequences, and the questions
that matter before running them on a real database are not "is the new predicate faster". They
are:

* How long does each migration hold locks, and who waits behind them?
* Does the application keep serving during the migration, and for how long does it not?
* What does each migration write to WAL, and how much does it grow the database?
* If a migration is interrupted, is anything left half-applied?
* Does the projection end up exactly right?

This command answers those by running them and measuring, rather than by reasoning about them.

---

## 2. Threat model

The rehearsal has three distinct risk surfaces, and each is handled explicitly.

### 2.1 The rehearsal destroys the wrong database

This is the serious one. The command creates a database, applies DDL, terminates a backend with
`pg_terminate_backend`, and mutates claim statuses. Pointed at a developer's working ledger it
would do all of that to data nobody measured first, and its own report would describe the
result as a successful experiment.

**Controls.**

* The target is validated **by name, before a single connection is opened**
  (`packages/perf/src/rehearsal-target.ts`). The validator refuses:
  * any PostgreSQL system database (`postgres`, `template0`, `template1`);
  * any database whose name equals the database named by the configured `DATABASE_URL` or
    `MIGRATION_DATABASE_URL` — this is the control that makes pointing the rehearsal at the
    ordinary database impossible, and it compares against the configured URLs rather than
    against a hard-coded name;
  * any name that does not contain the literal word `rehearsal`, so the target is
    self-describing in `pg_database`, in a connection log, and in the report;
  * any name that is not a legal unquoted PostgreSQL identifier, because `CREATE DATABASE`
    cannot take a parameter and the name is interpolated into DDL.
* There is **no flag that disables these checks**. The only choices are *which* disposable
  database, not *whether* it is disposable.
* A database that already exists is reused only if it is **empty** or carries this command's
  own marker table (`vm_a2_rehearsal`). A database holding relations without the marker is
  refused, and the refusal names them.
* By default the command creates a **uniquely named** database
  (`veritymem_rehearsal_<timestamp>_<suffix>`) and drops nothing at all.
* `pnpm db:reset` and the Compose volume are never touched.

### 2.2 The rehearsal kills the wrong backend

The interruption case terminates a PostgreSQL backend. Aimed at the wrong pid it would kill
somebody's query, or the postmaster.

**Controls.** `pg_terminate_backend` is called with exactly one pid, and only after re-reading
that pid from `pg_stat_activity` and checking that its `datname` is this rehearsal's own
database **and** its `application_name` is `veritymem-migration-rehearsal`. If either does not
match, the case does not terminate anything and reports what it saw instead. The shared Docker
service's postmaster is never a candidate: the command only ever names a backend PostgreSQL
reported for its own database.

### 2.3 The report claims more than it measured

A report is easier to over-read than to produce. A missing measurement that quietly becomes a
zero, a percentile over samples that came from the migration's own connection, or a "verified"
projection concluded from row counts alone would each turn this into false evidence.

**Controls.**

* Every nullable field is registered as `measured`, `not_applicable` or `missing`
  (`packages/perf/src/rehearsal-metrics.ts`). Only `not_applicable` is exempt from the
  completeness check, and it always carries a reason — there is no `claim_entities` during
  0014, so its size there is not a missing measurement.
* A report with **any** `missing` measurement, any failed projection invariant, any failed
  recovery case, or any probe operation that never succeeded sets `complete: false`, lists an
  explicit reason for each, and exits **1**.
* Every workload sample is tagged `source: "probe"`, and the completeness check fails if a
  single sample is not. Migration statements are timed on the migration's own connection and
  never enter an application percentile.
* `assertJsonSafe` walks the report before it is written and refuses `NaN`, `Infinity`,
  `undefined`, `Date` and `BigInt` — the values `JSON.stringify` silently turns into `null`, a
  string, a dropped key, or an exception. This guard has already caught one real defect: a
  phase-aware row count whose SQL lost its column alias, so every count came back `NaN`, and
  `NaN !== 0` let the "did the corpus land" check pass over an empty load.
* The projection is verified by **restating the invariant and recomputing the expected rows
  from the claim table**, not by comparing aggregate counts. See §6.

### 2.4 What is deliberately *not* protected against

* A hostile operator with the migration credentials. The rehearsal is a developer tool; it
  authenticates as the same owner role `pnpm migrate` uses. It is not a sandbox.
* A shared PostgreSQL server under someone else's control. Lock and WAL figures are
  cluster-wide (see §7), and another workload's writes will appear in them.
* Disk exhaustion. The larger profile loads tens of thousands of claims per tenant into a new
  database; the report records the database's size before and after but does not check free
  space first.

---

## 3. Commands

### 3.1 The CI profile

```bash
pnpm eval:perf migration-rehearsal --profile ci --output reports/vm-a2-ci.json
```

### 3.2 A larger local profile

```bash
pnpm eval:perf migration-rehearsal --profile local --output reports/vm-a2-local.json
```

### 3.3 An explicit disposable database

```bash
# Created if absent. Reusing an existing VM-A2 target requires an explicit --recreate.
pnpm eval:perf migration-rehearsal \
  --rehearsal-url 'postgres://verity:verity@127.0.0.1:55432/veritymem_rehearsal_scratch' \
  --recreate \
  --claims 5000 \
  --duration 60 \
  --output reports/vm-a2-scratch.json
```

Pointing `--rehearsal-url` at `.../veritymem`, at `postgres`, or at any name that does not
contain `rehearsal` is refused before connecting.

### 3.4 Options

| option | default (ci / local) | meaning |
| --- | --- | --- |
| `--profile <ci\|local>` | `ci` | a named set of the parameters below; neither is production scale |
| `--claims <n>` | 2000 / 50000 | claims loaded **per tenant** |
| `--tenants <n>` | 2 / 2 | how many tenants to load; at least 2 makes the RLS check non-vacuous |
| `--read-concurrency <n>` | 2 / 4 | simultaneous read probes (lexical, entity, hydration, round-robin) |
| `--write-concurrency <n>` | 1 / 2 | simultaneous append probes, and as many projection probes again |
| `--duration <seconds>` | 20 / 300 | length of the **measured** probe window, excluding the paused failing attempts |
| `--statement-timeout <ms>` | 5000 / 30000 | `statement_timeout` on every application probe connection |
| `--lock-timeout <ms>` | 400 / 2000 | `lock_timeout` on the probes, **and** on each migration attempt |
| `--output <path>` | required | report path; parent directories are created |
| `--rehearsal-url <url>` | — | an explicit disposable database |
| `--database <name>` | generated | name for a newly created database |
| `--recreate` | false | explicitly drop and recreate an existing target with a valid VM-A2 marker |
| `--migrations <dir>` | `<repo>/migrations` | migrations directory |
| `--sample-interval <ms>` | 200 | how often `pg_stat_activity` and `pg_locks` are sampled |
| `--blocked-threshold <ms>` | 1000 | a blocked statement longer than this is counted |
| `--observation-timeout <ms>` | 20000 | how long to wait for the migration to reach the statement the interruption case blocks it on |
| `--seed <text>` | `veritymem-perf-v1` | corpus seed |
| `--anchor <iso>` | `2026-09-17T12:00:00.000Z` | corpus time anchor |

Exit codes: **0** the report is complete; **1** the report is incomplete, or the run was
refused; **2** the command could not run at all.

### 3.5 Safety rules, restated as a checklist

1. **Never** pass `--rehearsal-url` a database you care about. It must point to the same
   PostgreSQL host and port as the configured migration connection; cross-server targets are
   refused before inspection.
2. Omit explicit target options unless you specifically need a named database. The default
   creates a fresh one and drops nothing.
3. An existing target is never dropped implicitly. `--recreate` is required, and it works only
   when the target has one exact VM-A2 ownership record with the expected schema, sentinel and
   marker version. A table merely named `vm_a2_rehearsal` is refused.
4. Do not point the rehearsal at a PostgreSQL instance you do not own. It terminates one of
   its own backends and reads cluster-wide WAL figures.
5. The rehearsal leaves its database correct but no longer pristine: a handful of probe claims
   are moved to `disputed`, `revoked`, `rejected` and `superseded` by the behaviour checks.

---

## 4. What the command does, in order

1. Validate the target by name; create it, mark it, install `vector` and `pg_trgm`, and grant
   `veritymem_app` access.
2. Migrate it **through 0013 only** (the corpus stops at the same boundary).
3. Load a deterministic corpus, as the owner role, stopping the loader before its
   `claim_entities` phase — that table does not exist yet, which is exactly the production
   state before 0015.
4. Start the workload **as `veritymem_app`**, and record which phases each operation belongs
   to. The workload runs against the 0013 schema first; §5 explains why that produces failures
   and why they are recorded rather than avoided.
5. Apply **0014** while the workload runs.
6. Resolve the probe vocabulary now that the channels work, and confirm every reachable probe
   operation returns rows.
7. Pause the workload and run the two **failing** attempts at 0015: one that must time out on a
   held lock, and one that is terminated mid-transaction.
8. Apply **0015** for real, under load — it is the *rerun after the interruption*, so the
   migration whose telemetry is published has already been proved to recover from an abort.
9. Rerun once more to prove idempotence.
10. Run the deterministic post-migration writes, verify the projection, the projection's
    behaviour on status changes, and the tenant boundary; then write the report.

---

## 5. The schema-compatibility findings

The rehearsal's most useful output is not a duration. Running the *current* application code
against the 0013 schema, and then against the 0014 schema, measures which schema each path
requires. It found three dependencies, each derived from recorded SQLSTATEs rather than
asserted in prose:

| finding | evidence | consequence |
| --- | --- | --- |
| `read_path_requires_0014` | lexical retrieval records `42883` (`undefined_function`) against 0013, and for the duration of 0014's transaction | apply 0014 before the application version that calls it serves reads, or accept a read outage for exactly the length of 0014 |
| `function_replacement_disrupts_active_callers` | claim hydration records `42601` (`syntax error at or near "SELECT"`, against the function's own body) only in the 0014 window | 0014 is an **offline** migration for the read path: it does not merely require the new function, it makes calls to the old one fail intermittently while it is swapped. Drain reads, or accept sporadic errors |
| `projection_exposed_to_function_replacement` | the projection write path records `42501` only in the 0014 window | the same window exposes writes, not just reads |
| `entity_channel_requires_0015` | the entity channel records `42P01` (`undefined_table`) from 0013 until 0015 commits | a caller that fuses channel results must treat the entity channel as *unavailable* for that window, not as empty |
| `projection_requires_0015` | the projection write path records `42P01` in the same window | expect projection failures for the whole of 0015 and retry them; do not read them as lock contention |

The `42601` deserves its own note, because it is the kind of thing that only a rehearsal finds.
The failing statement is logged by PostgreSQL against the body of
`veritymem.scope_reachable`, a `LANGUAGE sql` function that 0014 replaces with
`CREATE OR REPLACE FUNCTION` while concurrent sessions are calling it through the old
`row_authorized` predicate. A session that is mid-call when the replacement commits can fail to
re-parse the body. The server log for the run shows it exactly:

```
ERROR:  syntax error at or near "SELECT" at character 4
QUERY:
      SELECT COALESCE(
        p_scope IS NOT NULL
        AND COALESCE(array_length(p_purposes, 1), 0) > 0
        AND p_scope = ANY(veritymem.current_reachable_scope_ids()),
        FALSE
      )
```

That is the *function body*, not a statement this project sends. It occurs once or twice per
run, only in the 0014 window, and it is the reason the recommendation for 0014 is "apply it
during a read drain" rather than "apply it and retry". The equivalence-class of this failure is
also why `project_claim` records a `42501` in the same window: the row-level-security predicate
is being replaced underneath it.

`42P01` rather than a lock timeout is the important detail: `claim_entities` is created **inside
0015's transaction**, so it is not visible to any other session until 0015 commits. A
projection write in that window cannot wait for a lock — the relation does not exist yet. A
retry loop with a lock timeout is not sufficient; the retry has to survive
`undefined_table`.

The command also records a `compatibility` table: for each phase, per operation, the attempts,
successes and distinct SQLSTATEs. That is the raw evidence behind the findings, and it is what
makes an availability number interpretable rather than mysterious.

---

## 6. Reading the report

The report is `vm-a2.migration-rehearsal.1`. Its top level:

| field | meaning |
| --- | --- |
| `git` | commit, branch and dirty flag of the *rehearsal*, not of the migrations |
| `postgres` | server version, pgvector version, and the settings a reader needs to interpret timings (`shared_buffers`, `work_mem`, `max_parallel_workers_per_gather`, `wal_level`, …) |
| `migrations.hashes` | SHA-256 of **every** migration file on disk, so the exact revision is pinned |
| `environment` | profile name, its note, and every effective parameter |
| `target` | database name, mode (`created` / `selected` / `recreated`), redacted URL, the three protection statements, size before and after |
| `roles` | migration and application role identities, both privilege attributes, and whether the migration role owns the migrated tables |
| `corpus` | seed, anchor, claims per tenant, per-tenant table counts, total claims, load time |
| `telemetry` | one record per measured migration — §6.1 |
| `workload` | availability per operation, overall and per phase — §6.2 |
| `projection` | the stated invariants, their measured counts, the residue, the behaviour cases, and the tenant-boundary check — §6.3 |
| `recovery` | the four cases, the objects present after each failure, and the final migration history — §6.4 |
| `compatibility` | which operations worked in which schema state, with error codes |
| `findings` | conclusions derived from the recorded evidence |
| `measurements` | the register of measured / not-applicable / missing fields |
| `limitations` | what the report is not evidence for, stated in the report itself |
| `complete`, `incompleteness_reasons` | the verdict and every reason for it |

### 6.1 `telemetry[]` — per migration

Recorded independently for 0014 and 0015:

* `started_at`, `finished_at`, `elapsed_ms`, `exit_code`, `outcome`, `error`;
* `backend_pid` — the server-reported session that ran it;
* `lock_timeout_ms`, `lock_acquisition_wait_ms`, `lock_wait_windows`;
* `locks_held[]` — every `(locktype, mode, relation)` observed, with the number of samples it
  was held in;
* `blocked_sessions[]` — pid, the mode and relation of the lock it was waiting for, the sampled
  waiting time, the longest statement elapsed time observed, and a truncated query sample;
* `blocked_sessions_count`, `statements_blocked_over_threshold`;
* `wal` — `lsn_before`, `lsn_after`, `bytes_generated`, and `error` when it could not be
  computed;
* `database_size` — before, after and delta;
* `claim_entities` — present before/after, total and index bytes before/after, rows before and
  after, and `rows_backfilled`;
* `temporary_files` — `pg_stat_database` counters before and after;
* `projection_after` — rows, duplicate keys, orphan rows and missing rows read immediately
  after that migration committed;
* `sampling` — the sample count, the configured interval, the **effective** interval actually
  observed, the warm-up window, the threshold, sampling errors and the lock-wait windows.

**Two numbers are lower bounds, and the report says so.** `lock_acquisition_wait_ms` is the sum
of the sampling intervals during which the migration backend was observed waiting for a lock: a
wait shorter than the interval can fall entirely between two samples. `blocked_sessions[].observed_waiting_ms`
has the same shape. The one exact wait in the report is the `lock_timeout` recovery case, where
the wait is the configured timeout.

`blocked_sessions[].max_statement_elapsed_ms` is `now() - query_start` at sample time, which is
an **upper** bound on the lock wait because it includes whatever work the statement did before
it blocked.

### 6.2 `workload` — availability

For each of `lexical_retrieval`, `entity_retrieval`, `claim_hydration`, `append_event` and
`project_claim`, overall and per phase: `attempts`, `successes`, `failures`, `timeouts`,
`empty_results`, `p50` / `p95` / `p99` / `max` duration, the longest outage window, and errors
grouped by SQLSTATE with one truncated, identifier-redacted sample message.

* `outage.longest_ms` is the longest interval, bounded by the observation window, in which the
  operation never completed successfully. It is measured on **completion** times, so it answers
  "when did the system last serve this operation".
* `outage.has_success: false` means nothing succeeded in that window, and `longest_ms` is then
  the whole window — an outage by definition rather than by measurement.
* `empty_results` counts successful attempts that returned no rows. A retrieval probe that
  succeeds while returning nothing has not served the request it was measuring, so the count is
  published rather than being folded into the success rate.
* Phases are `pre_migration` (0013 schema), `migration_0014`, `post_0014`, `migration_0015`,
  `post_migration`, and `recovery`. The `recovery` phase covers the two deliberately failing
  attempts, during which the probes are **paused** so an outage caused by the fault injector is
  not attributed to a migration; it therefore reports **zero attempts** for every operation,
  which is the evidence that the pause worked. The `migration_0015` phase spans 0015's
  successful application — which is the rerun after the interruption — and the idempotence
  rerun that follows it.

Migration connection timings are structurally excluded: the workload is the only producer of
samples, every sample is tagged `source: "probe"`, and the completeness check fails if any
sample is not.

### 6.3 `projection` — the invariants

The invariants are stated in the report and were fixed before the run. In words:

> **Completeness.** For every claim with status `accepted` or `disputed`, and for every
> canonical value it yields, there is exactly one `claim_entities` row for
> `(tenant_id, canonical, claim_id)`.
>
> Two definitions of "the canonical values it yields" are checked independently: **M**, the
> migration's own definition (trimmed lowercase `subject` when non-empty; a JSON string `object`
> when non-empty, at most 200 characters *untrimmed*, and different from the subject after
> lowering), and **W**, the write path's definition (the same, but with the length bound applied
> to the *trimmed* object). 0015's backfill promises M; every claim written afterwards is
> projected by W. The report publishes the expected row count and the missing row count under
> both, so a divergence between them is visible rather than averaged away.
>
> **No extras.** No `claim_entities` row exists for an accepted or disputed claim whose
> canonical is not in that claim's write-path canonical set.
>
> **No orphans.** Every `claim_entities` row references a claim that exists.
>
> **Tenant agreement.** Every `claim_entities` row's `tenant_id` equals its claim's `tenant_id`.
>
> **Key uniqueness.** No `(tenant_id, canonical, claim_id)` triple appears twice, and the
> primary key that makes that structural is present.
>
> **Row-level security.** `claim_entities` has row-level security enabled.
>
> **Tenant boundary.** Bound as `veritymem_app` to tenant A's scopes, a count of
> `claim_entities` returns exactly tenant A's own row count, a count filtered to tenant B
> returns zero, and tenant B's own view is greater than zero — so the check cannot pass
> vacuously on a single-tenant database.

The invariant counts are computed as the **owner** role, because a completeness check run as
`veritymem_app` could not tell "no violation" from "no visibility". The tenant-boundary check
runs as `veritymem_app` on purpose, and asserts that it sees *less*.

`projection.behaviours[]` records the expected and observed behaviour for claims that stop
being accepted. The expectations are stated before they are checked:

* **disputed stays projected** — a disputed claim is a live claim; removing it would make the
  disagreement invisible;
* **revoked and rejected are deindexed** — re-projecting a claim whose status is neither
  accepted nor disputed removes its `claim_entities` and `claim_embeddings` rows;
* **superseded is not retrievable** — checked by running the *real entity channel* before and
  after a status change and comparing the hit list.

`projection.residue` reports `claim_entities` rows whose claim is no longer accepted or
disputed. Expect this to be **non-zero and expected**: when the commit gate supersedes an older
accepted claim it does not re-project the claim it superseded, so that claim keeps its
projection rows until something rebuilds them. Those rows are not retrievable — the retrieval
channels filter on `status = 'accepted' AND valid_to IS NULL`, and
`revoked_claim_is_not_retrievable` proves it against the real channel — but the residue is a
fact about the projection, so it is published rather than cleaned up silently.

### 6.4 `recovery` — failure and recovery

| case | what is arranged | what must be true afterwards |
| --- | --- | --- |
| `lock_timeout_while_0015_waits_on_a_conflicting_lock` | another session holds `ACCESS EXCLUSIVE` on `claims`; 0015 runs with `--lock-timeout` | 0015 fails with `55P03`, **no** `schema_migrations` row is recorded, and none of the objects 0015 creates survives |
| `interrupted_transaction_before_commit` | another session holds `EXCLUSIVE` on `events` so `CREATE INDEX` blocks; the case polls `pg_locks` until the migration backend is observed waiting, then terminates exactly that backend | the same: no history row, and the table, its primary key, both of its indexes, the three tenant indexes it adds and its RLS policy are all rolled back |
| `rerun_after_interruption` | the blocker is released and the migrations run again | exactly `0015` is applied, exactly one history row exists for it, and every object it creates is present |
| `rerun_after_successful_application` | the migrations run once more over the applied schema | nothing is applied, no new history row appears, and the projection is still exact |

The interruption is **deterministic**, not a race: the case waits for the migration to be
*provably* blocked before terminating it. If the wait is never observed the case reports
`not_exercised`, which makes the report incomplete rather than falsely green.

---

## 7. What the results prove

* Each migration's wall time, lock set, blocking, WAL delta, database growth and
  temporary-file usage on this corpus, on this server, at this revision of the migration files
  (pinned by SHA-256 in the report).
* That the application's five operations were attempted and served from real code paths — the
  production retrieval channels, the ledger's write boundary, the ingest pipeline and the
  production projection — as `veritymem_app`, with `rolsuper` and `rolbypassrls` both false.
* That DDL inside these migrations is transactional: an aborted or terminated 0015 leaves no
  table, no index, no policy and no history row behind.
* That the migrations converge on rerun, and are idempotent when already applied.
* That after 0015 the projection is exactly right under both canonical definitions, that it is
  isolated between tenants, and that revocation and rejection deindex while dispute does not.
* Which schema each application path depends on, from recorded SQLSTATEs.

## 8. What the results do **not** prove

* **Nothing about latency.** This command contains no latency target and no before/after
  comparison. `p50`/`p95`/`p99` describe availability during a migration window on a synthetic
  corpus; they are not a benchmark and must not be quoted as an improvement.
* **Nothing about ANN or vector-search performance.** The dense channel is exercised only as
  one of the paths that keeps running; no recall, no throughput and no index-quality claim is
  made.
* **Nothing about production readiness.** Neither profile is production scale, the corpus is
  synthetic and deterministic, the server is a single instance on the same host as the client,
  and there is no replication, no pooler and no other traffic.
* **Nothing attributable solely to the migration, for WAL.** PostgreSQL publishes one WAL
  stream per cluster, so the workload's own writes are inside every WAL delta. The corpus's
  claim counts and the probe's write counts are published next to it so the contamination can
  be sized.
* **Nothing about lock waits shorter than the sampling interval**, and nothing exact about
  blocked-session duration beyond the bounds in §6.1.
* **Nothing about other PostgreSQL versions.** The version and pgvector extension version are
  read from the server at run time; a different version may lock, plan or write WAL
  differently.
* **Nothing about a different revision of the migrations.** The report pins their SHA-256.

## 9. Rollback and recovery implications

* **0014 and 0015 are not reversible by running an earlier migration.** There is no down
  migration, and both create objects the application then depends on. Rolling back means
  restoring a backup, not editing `schema_migrations`.
* **Both migrations are transactional**, and the rehearsal proves it for the failure modes it
  can arrange: a lock timeout and a terminated backend. Because PostgreSQL DDL is transactional,
  an interrupted 0015 rolls back completely — no partial table, no partial index, no partial
  history row.
* **A failed migration is safe to rerun.** `runMigrations` records the history row in the same
  transaction as the migration, so an abort leaves nothing to clean up, and the next run
  applies the migration from the beginning.
* **An applied migration is safe to rerun.** The runner compares checksums and skips what is
  already applied; a modified file is refused outright rather than silently re-applied.
* **The rollout order matters, and the rehearsal measures why.** 0014 must be applied before
  the application version that calls `veritymem.current_reachable_scope_ids()` serves reads.
  0015 creates `claim_entities` inside its own transaction, so entity retrieval and projection
  writes fail with `42P01` until it commits — retries must survive `undefined_table`, not just
  lock contention. Both are recorded as findings with their evidence in the report.
* **The projection is disposable.** `rebuildProjections` can reconstruct `claim_entities` from
  the claim table, which is the property that makes 0015's lock window a scheduling problem
  rather than a data-loss risk.

## 10. Known environmental constraints

* **Docker `/dev/shm`.** The Compose service sets `shm_size: 1gb`. PostgreSQL allocates dynamic
  shared memory for parallel workers, and with a small `/dev/shm` a parallel plan over a large
  corpus fails with `dsm_impl_posix: could not resize shared memory segment`. The corpus loader
  passes `max_parallel_workers_per_gather=0` as a *connection option* for exactly this reason —
  a `SET` would not reach the loader's own pool. The rehearsal's **migration and probe**
  connections are deliberately left at the server's defaults, so the migration is measured
  under whatever topology PostgreSQL chooses; a `/dev/shm` too small for the parallel plan will
  show up as a probe failure with a `53xxx`/`53200`-class SQLSTATE rather than being hidden.
* **`statement_timeout` wins over a URL's `options` string.** The pool's own `statement_timeout`
  configuration key takes precedence over `options=-c statement_timeout=…`, so a connection URL
  that appears to set a timeout silently does not. The rehearsal sets both timeouts through
  `DbOptions` (`statementTimeoutMs`, `lockTimeoutMs`) for this reason.
* **Sample interval and migration duration.** A migration that commits in tens of milliseconds
  cannot be sampled densely at a 200 ms interval, and two samples that bracket it would record
  a lock wait of zero while missing every lock it held. The sampler therefore runs at 20 ms for
  its first 500 ms and then settles into `--sample-interval`; the report publishes both the
  configured interval and the **effective** mean interval so the reader can tell which applied.
  Even so, a very short migration yields few samples, and `locks_held` reflects only what was
  seen at those instants. Raise `--claims` to make the migration long enough to sample.
* **`--duration` excludes paused time.** The two failing attempts run with the probes paused,
  so their elapsed time is not part of the measured window; it is reported per recovery case.
* **Local disk.** The larger profile creates a database of tens of megabytes per run and does
  not delete it. Remove rehearsal databases when they are no longer wanted:
  `DROP DATABASE veritymem_rehearsal_<...>`.
* **No `psql` is required.** Every database interaction goes through `pg`, so the command works
  wherever the test suite does.
* **Not part of `scripts/verify.sh`.** The rehearsal provisions a database, runs for minutes and
  can legitimately fail on a machine with no PostgreSQL; folding it into the release gate would
  make that gate depend on resources it does not otherwise need. It is run explicitly, and its
  integration test (which does fail rather than skip when the database is absent) is part of
  `pnpm test`.

---

## 11. Recorded evidence

Everything in this section was produced by the commands in §3, on the machine and versions each
report records. `reports/` is gitignored, so the reports themselves are not committed; the
commands reproduce them exactly, because the corpus is seeded and anchored.

### 11.1 Environment

| | |
| --- | --- |
| PostgreSQL | 17.11 (Debian 17.11-1.pgdg13+2), container `veritymem-postgres` on `127.0.0.1:55432` |
| pgvector | 0.8.6 |
| Node | v24.18.0 (`--experimental-strip-types`) |
| server settings | recorded verbatim in each report under `postgres.settings` |

### 11.2 Acceptance ladder

| command | exit code | result |
| --- | --- | --- |
| `pnpm migrate:verify` | **0** | `applied=0 already-applied=15 total=15` |
| `pnpm typecheck` | **0** | no diagnostics |
| `pnpm test` | **0** | 516 tests, 516 pass, 0 fail, 0 skipped |
| `pnpm eval:perf migration-rehearsal --profile ci --output reports/vm-a2-ci.json` | **0** | `complete: true`, 0 incompleteness reasons |
| `pnpm eval:perf migration-rehearsal --profile local --output reports/vm-a2-local.json` | **0** | `complete: true`, 0 incompleteness reasons |
| `bash scripts/verify.sh` | **1** | **0 hard failures.** The only failure is the pre-existing LedgerBench release gate, with the same 7 reasons it had before this branch: five targets `not_measured` (contradiction detection's human-authored cases, p95 query latency at the reference scale, reference-workload burden, a human audit set, an external isolation assessment, an external user workload) and one `fail` (`deterministic_projections`, which is `fail` whenever the projections are not rebuilt and compared). Nothing in this branch weakened that gate, and none of its reasons is about the migration rehearsal. |

`scripts/verify.sh` is deliberately unchanged by this branch: the rehearsal provisions a
database and runs for minutes, so folding it into the release gate would make that gate depend
on resources it does not otherwise need. Its integration test *is* part of `pnpm test`, which
the gate runs.

### 11.3 CI profile

Both reports name commit `ecf4971` with `dirty: false`, so each artifact identifies the
revision that produced it.

**Command.** `node --experimental-strip-types packages/perf/src/main.ts migration-rehearsal --profile ci --output reports/vm-a2-ci.json`

**Report.** `reports/vm-a2-ci.json`, SHA-256 `917e34d21b2d5e664e3a064c89e6241430c190f31832ef15a76a45eeb59bea70`, schema `vm-a2.migration-rehearsal.1`, `complete: true`, 0 incompleteness reason(s).

**Corpus.** 4,000 claims across 2 tenants (2,000 per tenant), seed `veritymem-perf-v1`, anchor `2026-09-17T12:00:00.000Z`, loaded in 9.8 s.

**Target.** `veritymem_rehearsal_20260922t192840z_5719f9` (created); database size 9,295,539 B → 67,581,619 B.

| migration | outcome | elapsed | WAL | db Δ | lock modes seen | blocked | over threshold | rows backfilled | claim_entities | index |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `0014_precomputed_scope_reach.sql` | committed | 15 ms | 0.01 MiB | 0.02 MiB | ExclusiveLock | 0 | 0 | — | — | — |
| `0015_claim_entity_index.sql` | committed | 86 ms | 3.85 MiB | 2.01 MiB | AccessShareLock, ExclusiveLock, AccessExclusiveLock, RowExclusiveLock, RowShareLock, ShareLock, ShareRowExclusiveLock | 1 | 0 | 6,438 | 1.30 MiB | 0.63 MiB |

Sampler: 2 samples at an effective 11.0 ms (configured 200 ms, warm-up 500 ms); 4 samples at an effective 22.0 ms (configured 200 ms, warm-up 500 ms).

Blocked sessions (sampled; `observed` is a lower bound, `statement` an upper bound on the lock wait):

| migration | pid | waiting for | observed waiting | longest statement | statement |
| --- | --- | --- | --- | --- | --- |
| `0015_claim_entity_index.sql` | 37917 | RowExclusiveLock on claims | 21 ms | 13 ms | `INSERT INTO claims ( claim_id, tenant_id, scope_id, kind, subject, pre` |

| operation | attempts | ok | fail | timeouts | p50 | p95 | p99 | max | longest outage | error codes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lexical_retrieval` | 256 | 156 | 100 | 0 | 36 ms | 40 ms | 44 ms | 54 ms | 2.1 s | 42883 ×100 |
| `entity_retrieval` | 257 | 96 | 161 | 0 | 3 ms | 286 ms | 325 ms | 352 ms | 5.2 s | 42P01 ×161 |
| `claim_hydration` | 255 | 255 | 0 | 0 | 3 ms | 6 ms | 10 ms | 27 ms | 1.0 s | — |
| `append_event` | 1,229 | 1,228 | 1 | 0 | 5 ms | 10 ms | 17 ms | 39 ms | 0.7 s | 42501 ×1 |
| `project_claim` | 665 | 522 | 143 | 0 | 18 ms | 27 ms | 44 ms | 64 ms | 2.9 s | 42P01 ×143 |

Per-phase availability (`ok` / attempts):

| phase | `lexical_retrieval` | `entity_retrieval` | `claim_hydration` | `append_event` | `project_claim` |
| --- | --- | --- | --- | --- | --- |
| `pre_migration` | 0/98 | 0/99 | 97/97 | 117/117 | 0/63 |
| `migration_0014` | 4/6 | 0/4 | 6/6 | 6/7 | 1/5 |
| `post_0014` | 56/56 | 0/58 | 58/58 | 126/126 | 0/76 |
| `recovery` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| `migration_0015` | 2/2 | 2/2 | 0/0 | 7/7 | 4/4 |
| `post_migration` | 94/94 | 94/94 | 94/94 | 972/972 | 517/517 |

Projection: 8/8 invariants satisfied; expected rows under the migration predicate 6,452, under the write-path predicate 6,452; accepted-or-disputed claims written after 0015 7 with 0 missing projection rows.

Tenant boundary: bound to `rehearsal-5719f9-t0` the application role sees 3,363 rows against the owner's 3,363, and 0 rows belonging to `rehearsal-5719f9-t1`, which itself holds 4,121.

Residue: 1,038 `claim_entities` rows for 519 claims that are no longer accepted (superseded 1,038). These are not retrievable — see §6.3.

Behaviour cases:

* `disputed_claim_stays_projected` — passed. rows before: 2 entity / 1 embedding; after accepted -> disputed: 2 / 1; projected=true (projected)
* `revoked_claim_is_deindexed` — passed. after disputed -> revoked and re-projection: 0 entity / 0 embedding; projected=false (status revoked is not projected)
* `rejected_claim_is_deindexed` — passed. after accepted -> disputed -> rejected and re-projection: 0 entity / 0 embedding; projected=false (status rejected is not projected)
* `revoked_claim_is_not_retrievable` — passed. canonical user:user:rehearsal-preflight-0: hits before = 1 (claim present: true), hits after = 0 (claim present: false); projection rows 2 -> 0; projected=false

Recovery cases:

| case | status | detail |
| --- | --- | --- |
| `lock_timeout_while_0015_waits_on_a_conflicting_lock` | passed | failure: migration 0015_claim_entity_index.sql failed: canceling statement due to lock timeout; SQLSTATE 55P03; 0015 history rows 0; all objects absent true |
| `interrupted_transaction_before_commit` | passed | failure: migration 0015_claim_entity_index.sql failed: terminating connection due to administrator command; 0015 history rows 0; all objects absent true; pg_terminate_backend(37938) on veritymem_rehearsal_20260922t192840z_5719f9 as veritymem-migration-rehearsal returned true |
| `rerun_after_interruption` | passed | applied ["0015_claim_entity_index.sql"]; 0015 history rows 1; all objects present true |
| `rerun_after_successful_application` | passed | applied 0; already applied 15 of 15 recorded migration(s); missing projection rows 0; verify error (none) |

Migration history after everything: 15 row(s), ending at `0015_claim_entity_index.sql`; objects present afterwards: claim_entities=true, claim_entities_pkey=true, claim_entities_claim_idx=true, claim_embeddings_tenant_model_idx=true, events_tenant_seq_desc_idx=true, claims_current_tenant_scope_idx=true, claim_entities_authorized_policy=true.

Findings derived from the recorded SQLSTATEs:

* `read_path_requires_0014` — lexical_retrieval — pre_migration: 98 failure(s), SQLSTATE 42883; migration_0014: 2 failure(s), SQLSTATE 42883
* `entity_channel_requires_0015` — entity_retrieval — pre_migration: 99 failure(s), SQLSTATE 42P01; migration_0014: 2 failure(s), SQLSTATE 42P01; post_0014: 54 failure(s), SQLSTATE 42P01
* `projection_requires_0015` — project_claim — pre_migration: 62 failure(s), SQLSTATE 42P01; post_0014: 71 failure(s), SQLSTATE 42P01

### 11.4 Larger local profile

Both reports name commit `ecf4971` with `dirty: false`, so each artifact identifies the
revision that produced it.

**Command.** `node --experimental-strip-types packages/perf/src/main.ts migration-rehearsal --profile local --output reports/vm-a2-local.json`

**Report.** `reports/vm-a2-local.json`, SHA-256 `89ca8415e82cb54fd67f7e7578e5529e70c43e29995512dd8c4df21208ec7bd6`, schema `vm-a2.migration-rehearsal.1`, `complete: true`, 0 incompleteness reason(s).

**Corpus.** 100,000 claims across 2 tenants (50,000 per tenant), seed `veritymem-perf-v1`, anchor `2026-09-17T12:00:00.000Z`, loaded in 229.0 s.

**Target.** `veritymem_rehearsal_20260922t192918z_824f76` (created); database size 9,295,539 B → 1,347,925,683 B.

| migration | outcome | elapsed | WAL | db Δ | lock modes seen | blocked | over threshold | rows backfilled | claim_entities | index |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `0014_precomputed_scope_reach.sql` | committed | 32 ms | 0.20 MiB | 0.05 MiB | ExclusiveLock | 0 | 0 | — | — | — |
| `0015_claim_entity_index.sql` | committed | 2054 ms | 56.95 MiB | 47.08 MiB | AccessShareLock, ExclusiveLock, AccessExclusiveLock, RowExclusiveLock, ShareLock, ShareRowExclusiveLock, RowShareLock | 4 | 2 | 161,264 | 31.01 MiB | 15.01 MiB |

Sampler: 2 samples at an effective 27.0 ms (configured 200 ms, warm-up 500 ms); 27 samples at an effective 54.8 ms (configured 200 ms, warm-up 500 ms).

Blocked sessions (sampled; `observed` is a lower bound, `statement` an upper bound on the lock wait):

| migration | pid | waiting for | observed waiting | longest statement | statement |
| --- | --- | --- | --- | --- | --- |
| `0015_claim_entity_index.sql` | 38686 | RowExclusiveLock on claims | 1379 ms | 1289 ms | `INSERT INTO claims ( claim_id, tenant_id, scope_id, kind, subject, pre` |
| `0015_claim_entity_index.sql` | 38644 | RowExclusiveLock on claims | 1379 ms | 1289 ms | `INSERT INTO claims ( claim_id, tenant_id, scope_id, kind, subject, pre` |
| `0015_claim_entity_index.sql` | 38645 | RowExclusiveLock on events | 96 ms | 65 ms | `INSERT INTO events ( event_id, stream_id, seq, tenant_id, scope_id, or` |
| `0015_claim_entity_index.sql` | 38650 | RowExclusiveLock on events | 96 ms | 65 ms | `INSERT INTO events ( event_id, stream_id, seq, tenant_id, scope_id, or` |

| operation | attempts | ok | fail | timeouts | p50 | p95 | p99 | max | longest outage | error codes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lexical_retrieval` | 2,065 | 1,053 | 1,012 | 0 | 849 ms | 1131 ms | 1345 ms | 1608 ms | 11.0 s | 42883 ×1012 |
| `entity_retrieval` | 2,062 | 988 | 1,074 | 0 | 6 ms | 90 ms | 107 ms | 236 ms | 30.0 s | 42P01 ×1074 |
| `claim_hydration` | 2,063 | 2,063 | 0 | 0 | 4 ms | 8 ms | 14 ms | 42 ms | 4.4 s | — |
| `append_event` | 33,944 | 33,943 | 1 | 0 | 7 ms | 14 ms | 26 ms | 195 ms | 4.2 s | 42501 ×1 |
| `project_claim` | 17,887 | 16,395 | 1,492 | 0 | 21 ms | 36 ms | 62 ms | 1427 ms | 29.4 s | 42P01 ×1491, 42601 ×1 |

Per-phase availability (`ok` / attempts):

| phase | `lexical_retrieval` | `entity_retrieval` | `claim_hydration` | `append_event` | `project_claim` |
| --- | --- | --- | --- | --- | --- |
| `pre_migration` | 0/1007 | 0/1005 | 1006/1006 | 1171/1171 | 0/655 |
| `migration_0014` | 8/13 | 0/13 | 13/13 | 183/184 | 0/112 |
| `post_0014` | 49/49 | 0/48 | 48/48 | 1196/1196 | 0/725 |
| `recovery` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| `migration_0015` | 18/18 | 12/20 | 18/18 | 346/346 | 115/115 |
| `post_migration` | 978/978 | 976/976 | 978/978 | 31047/31047 | 16280/16280 |

Projection: 8/8 invariants satisfied; expected rows under the migration predicate 161,278, under the write-path predicate 161,278; accepted-or-disputed claims written after 0015 7 with 0 missing projection rows.

Tenant boundary: bound to `rehearsal-824f76-t0` the application role sees 95,346 rows against the owner's 95,346, and 0 rows belonging to `rehearsal-824f76-t1`, which itself holds 98,712.

Residue: 32,786 `claim_entities` rows for 16,393 claims that are no longer accepted (superseded 32,786). These are not retrievable — see §6.3.

Behaviour cases:

* `disputed_claim_stays_projected` — passed. rows before: 2 entity / 1 embedding; after accepted -> disputed: 2 / 1; projected=true (projected)
* `revoked_claim_is_deindexed` — passed. after disputed -> revoked and re-projection: 0 entity / 0 embedding; projected=false (status revoked is not projected)
* `rejected_claim_is_deindexed` — passed. after accepted -> disputed -> rejected and re-projection: 0 entity / 0 embedding; projected=false (status rejected is not projected)
* `revoked_claim_is_not_retrievable` — passed. canonical user:user:rehearsal-preflight-0: hits before = 1 (claim present: true), hits after = 0 (claim present: false); projection rows 2 -> 0; projected=false

Recovery cases:

| case | status | detail |
| --- | --- | --- |
| `lock_timeout_while_0015_waits_on_a_conflicting_lock` | passed | failure: migration 0015_claim_entity_index.sql failed: canceling statement due to lock timeout; SQLSTATE 55P03; 0015 history rows 0; all objects absent true |
| `interrupted_transaction_before_commit` | passed | failure: migration 0015_claim_entity_index.sql failed: terminating connection due to administrator command; 0015 history rows 0; all objects absent true; pg_terminate_backend(38733) on veritymem_rehearsal_20260922t192918z_824f76 as veritymem-migration-rehearsal returned true |
| `rerun_after_interruption` | passed | applied ["0015_claim_entity_index.sql"]; 0015 history rows 1; all objects present true |
| `rerun_after_successful_application` | passed | applied 0; already applied 15 of 15 recorded migration(s); missing projection rows 0; verify error (none) |

Migration history after everything: 15 row(s), ending at `0015_claim_entity_index.sql`; objects present afterwards: claim_entities=true, claim_entities_pkey=true, claim_entities_claim_idx=true, claim_embeddings_tenant_model_idx=true, events_tenant_seq_desc_idx=true, claims_current_tenant_scope_idx=true, claim_entities_authorized_policy=true.

Findings derived from the recorded SQLSTATEs:

* `read_path_requires_0014` — lexical_retrieval — pre_migration: 1007 failure(s), SQLSTATE 42883; migration_0014: 5 failure(s), SQLSTATE 42883
* `entity_channel_requires_0015` — entity_retrieval — pre_migration: 1005 failure(s), SQLSTATE 42P01; migration_0014: 8 failure(s), SQLSTATE 42P01; post_0014: 40 failure(s), SQLSTATE 42P01; migration_0015: 8 failure(s), SQLSTATE 42P01
* `projection_exposed_to_function_replacement` — project_claim — migration_0014: 4 failure(s), SQLSTATE 42601
* `projection_requires_0015` — project_claim — pre_migration: 653 failure(s), SQLSTATE 42P01; migration_0014: 4 failure(s), SQLSTATE 42P01; post_0014: 615 failure(s), SQLSTATE 42P01

### 11.5 What the two runs establish

Both profiles completed with `complete: true` and exit 0, and the shape of the two runs is
consistent:

* **0014 is cheap and 0015 is not.** 0014 rewrites four functions and commits in tens of
  milliseconds with a fraction of a mebibyte of WAL at either size. 0015 creates a table,
  backfills 161 264 rows, builds a primary key and four indexes, and takes about two seconds
  and 57 MiB of WAL for 100 000 claims — and grows the database from 9 MB to 1.35 GB.
* **The blocking is real and attributable.** At the local size, four concurrent sessions were
  observed waiting behind 0015: two `INSERT INTO claims` for 1.3 s each, blocked by the
  `ShareRowExclusiveLock` 0015 takes on `claims` while building `claims_current_tenant_scope_idx`,
  and two `INSERT INTO events` for 96 ms. Two of them exceeded the 1 s threshold. The CI size,
  with a fifth of the corpus and a fifth of the write concurrency, records one blocked session
  for 20 ms — which is the honest difference between the two profiles, not a discrepancy.
* **The application's availability is explained by schema state, not by luck.** In every phase
  before 0015 commits, entity retrieval and projection fail with `42P01`; before 0014 commits,
  lexical retrieval fails with `42883`; in the 0014 window, hydration and projection record the
  `42601`/`42501` transients described in §5. After 0015 commits, every operation succeeds:
  978/978 lexical and hydration, 976/976 entity, 31 047/31 047 appends and 16 280/16 280
  projections in the local run's `post_migration` phase.
  A reader who wants to know "will my application work during this migration" gets the answer
  from the compatibility table, not from a single availability percentage.
* **Nothing is left half-applied.** Both failing attempts left zero history rows and none of
  0015's seven objects; the rerun applied exactly 0015 and recorded exactly one history row;
  the idempotence rerun applied nothing and re-verified the projection with zero missing rows.
* **The projection is exact under both definitions, and isolated.** 8/8 invariants pass in both
  runs, the expected row count agrees between the migration's canonical definition and the
  write path's, transiently-written claims are projected incrementally with zero rows missing,
  and the application role sees its own tenant's rows (89 846 against the owner's 89 846) and
  none of the other tenant's (0 against that tenant's 96 700).
* **The residue is expected and bounded.** 32 786 `claim_entities` rows belong to 16 393
  superseded claims in the local run. The entity channel does not return them, which
  `revoked_claim_is_not_retrievable` proves against the real channel, and the projection is
  rebuildable. It is published because it is a fact about the projection, not because it is a
  problem.

### 11.6 What could not be verified here

* **No second machine.** Both runs were on the developer's host, against a single PostgreSQL
  container with the server's own configuration. Nothing here establishes how these migrations
  behave under replication, behind a connection pooler, or on storage with different `fsync`
  characteristics.
* **No concurrent traffic other than this rehearsal.** The workload is synthetic and driven by
  this process, so the *contention* is real but the *demand* is not a production demand curve.
* **The mechanism of the 0014 transients is inferred from the server log, not from the
  report.** The report records the SQLSTATEs, the counts and the phase; the explanation in §5
  (a `LANGUAGE sql` function body being re-parsed while it is replaced) comes from reading
  PostgreSQL's own log of the failing statement. It was not proven by a controlled experiment,
  and the frequency is small enough that a run may record none at all. It did not affect any
  invariant: every projection check passed in every run that recorded it.
* **`locks_held` is sampled, so it is a floor.** Objects created inside a migration's own
  transaction have no `pg_class` name visible to the sampler, and are published by OID
  (`oid:<n>`) instead. A lock taken and released between two samples does not appear at all.
* **The interruption case depends on a poll.** It waits for the migration backend to be observed
  waiting on a lock before terminating it. If the observation never succeeds the case reports
  `not_exercised` and the report is incomplete — it never reports a pass it did not earn — but
  that also means the case's determinism rests on the polling interval being shorter than the
  wait it is looking for.
* **Not a million-claim result.** The larger profile loads tens of thousands of claims per
  tenant, and the exact figure is recorded in the report. No claim is made about a corpus of a
  million claims.
