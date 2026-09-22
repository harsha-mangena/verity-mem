# VM-A3 — channel-level plan capture: usage and evidence

VM-A3 adds `pnpm eval:perf explain`, which captures real PostgreSQL execution plans for every
VerityMem retrieval stage into one machine-readable artifact. This document is the usage guide
and the recorded evidence for the commit that introduced it.

The artifact is **diagnostic evidence, not a public API response**. Nothing here changes the
REST or MCP surface, and nothing here is a latency claim.

## Usage

```bash
pnpm eval:perf fixture       # once: provision the deterministic test tenant

pnpm eval:perf explain \
  --tenant vm-a3-plan-capture-fixture \
  --query "deployment window" \
  --limit 10 \
  --subject "user:eng-00" \
  --time-mode during \
  --from "2026-09-01T00:00:00.000Z" \
  --to "2026-10-01T00:00:00.000Z" \
  --output reports/vm-a3-plan-capture.json
```

| option | required | meaning |
| --- | --- | --- |
| `--tenant <slug>` | yes | tenant to capture against |
| `--query <text>` | yes | the query text to plan |
| `--limit <number>` | yes | `QueryRequest.limit`, 1..100 |
| `--output <path>` | yes | artifact path; refuses to overwrite without `--force` |
| `--time-mode <mode>` | no | `current` (default), `as_of`, `during` |
| `--as-of <timestamp>` | for `as_of` | the transaction-time instant |
| `--from <timestamp>` | for `during` | window start |
| `--to <timestamp>` | for `during` | window end |
| `--subject <subject>` | no, repeatable | declared subject; the relation channel is planned only for these |
| `--database-url <url>` | no | read path connection, RLS-bound application role (default from `.env`) |
| `--migration-url <url>` | no | metadata and version reads, owner role (default from `.env`) |
| `--purpose <purpose>` | no | declared purpose (default `release_planning`) |
| `--principal <id>` | no | caller to capture as; must participate in the tenant. Omit to use the first participant found, which is reported |
| `--force` | no | overwrite an existing artifact |

Exit codes: `0` captured and complete, `1` refused or incomplete, `2` could not run.

### The time options are a union, not a mode plus extras

The three modes are the contract's discriminated union: `current` carries nothing, `as_of`
carries exactly one instant, `during` carries exactly one interval. They cannot be mixed, so
each misuse is rejected rather than resolved:

| input | result |
| --- | --- |
| `--from`/`--to` with `current` or `as_of` | rejected: only valid with `during` |
| `--as-of` with `current` or `during` | rejected: only valid with `as_of` |
| `--time-mode as_of` without `--as-of` | rejected: required |
| `--time-mode during` without `--from` or `--to` | rejected: required |
| an unparseable timestamp | rejected |
| a timestamp that normalises to a different day (`2026-02-31`) | rejected |
| `--from` not strictly before `--to` | rejected: an empty or inverted window matches nothing, and the temporal plan would be over an empty set |

An earlier version accepted only `--time-mode`, which meant `during` could not be expressed at
all — so the temporal channel never ran and the artifact recorded eleven stages while claiming
to capture every one. The `as never` casts that let a malformed request reach `compose` are gone.

### Why `--subject` and `--time-mode` matter

Both channels are conditional:

* `relation_channel` is planned only for caller-declared subjects — terms mined from the query
  text deliberately do not narrow the query;
* `temporal_channel` issues no statement unless the time mode is `during`.

The artifact reports a conditional stage as **missing** rather than inventing an entry for a
plan nobody executed, and records `request.time_mode` and `request.declared_subjects` so a
reader can tell *the request did not select the stage* from *it ran and was not captured*.

## What it refuses, and why

| condition | why it is a refusal |
| --- | --- |
| the tenant does not exist | the run would describe a tenant nobody asked about |
| no claims exist | empty plans that read as passing evidence |
| the application role bypasses RLS or is a superuser | plans would omit the policy predicate, so the artifact would certify that the boundary does not exist |
| migrations are missing | the schema is not the one the artifact claims |
| the output exists without `--force` | an existing artifact cannot be replaced silently |
| no principal participates in the tenant | every plan would authorize nothing; the principal is discovered and reported rather than invented |
| **any secret survives sanitization** | nothing is written; see below |

## How the plans are obtained

**The statements are the production ones.** No channel SQL is written in `packages/perf`.
`packages/retrieval` exposes one seam — `ComposeOptions.observer`, with `withObservation`
wrapping the `QueryExecutor` the channels already use — so what is explained is what ran.

**The channel sees production behaviour.** The observed statement executes first and its rows
are returned untouched; the plan is captured afterwards with
`EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)` on the same statement and parameters.
Explaining first is wrong: `EXPLAIN ANALYZE` returns a plan, so a channel handed one would see
"no rows" and take its empty path — the model-mismatch branch, the empty-packet branch, the
abstention decision — and would report on the observability harness rather than the read path.

The cost is stated in the artifact: captured timings and buffer counters describe a **second,
warm-cache run**, and `capture.timing_note` says so.

**Attribution is bound to the executor, not queued.** `runChannels` runs the ordinary channels
and the dense channel on two concurrent transactions. Two attempts at a queue of pending stage
names — global, then per lane — let the lanes pair each other's names with each other's
statements; a trace showed `entity_channel` popping `dense_vector_search`. The stage name is now
a property of the executor a channel is handed, and `denseChannel` is given an executor per
statement so its two queries are attributed independently.

## Stored plans are sanitized

`EXPLAIN (FORMAT JSON)` is **not structure**. Several fields carry the statement as PostgreSQL
rewrote it, with bound values substituted:

```
Filter · Index Cond · Recheck Cond · Hash Cond · Join Filter · Merge Cond
One-Time Filter · Index Recheck · Function Call · Output · Sort Key · Group Key
Cache Key · Cache Mode · Presorted Key · Order By
```

For this system that means a plan can contain the tenant's UUID, the query text, the caller's
scopes and the declared subjects. The field is therefore named **`sanitized_plan`**, not
`raw_plan`: literals and UUIDs are replaced with placeholders, while topology, relations,
indexes, join structure, sort keys and operators are preserved, because that is what a plan is
read for. Calling a sanitized document "raw" would be a false claim about what a reader is
looking at.

Sanitization is not trusted on its own. Before writing, the capture walks the assembled
artifact and **refuses to write the file** if any value from that run is still present — the
tenant id and slug, the principal, the query text, the held scopes, the declared subjects, and
either connection URL — and rejects the credential markers `postgres://`, `postgresql://`,
`password` and `Bearer `. Error messages are sanitized too, because a PostgreSQL error repeats
the offending value and the values here are the tenant UUID and the principal.

The guard exists because a sanitizer's coverage is a claim about which fields PostgreSQL fills
with values, and a claim is not a proof.

## Structural digests versus file hashes

Each stage records a **`structural_plan_digest`**: the SHA-256 of a canonical form of the plan
with volatile fields removed and expression literals replaced.

* **Removed as volatile**: planning and execution time, actual startup and total time, actual
  rows and loops, buffer counters, WAL counters, cost estimates, rows removed by filter, sort
  method and space, memory and disk usage, and `Workers Launched` — which is runtime, since
  PostgreSQL reports how many workers it actually started.
* **Preserved as topology**: node types, relation and index names, join types, filter and join
  structure, sort and group keys, `Parallel Aware`, and `Workers Planned` — which is a planner
  decision, so dropping it would make a plan intending two workers indistinguishable from one
  intending none.
* **Canonicalized, not dropped**: expression strings. Two captures of the same query shape for
  two different tenants produce `Index Cond: (tenant_id = '3f2a…'::uuid)` and
  `(tenant_id = '9c1b…'::uuid)`; hashing those verbatim would give different digests for
  identical topology, and a digest that reports a change on every run is a digest nobody reads.

**The file hash is not a fingerprint of the plans.** `generated_at`, `commit` and every captured
timing differ between two runs, so the SHA-256 of the whole artifact moves on every run. Two
consecutive runs of the command above produced byte-identical digests for all twelve stages
while the file hash changed from `1998d099…` to `8e49df47…`. A change in a digest is a change in
plan shape; a change in the file hash is not evidence of anything.

## The test fixture

`pnpm eval:perf fixture` provisions a deterministic tenant. It reuses the production bulk loader
for the corpus and `projectClaim` — the function the outbox worker calls — for the entity
tables, so the fixture's rows come from the code under test rather than from a copy of it. **No
channel SQL is written in the fixture.**

It is idempotent: an already-complete fixture is returned without loading anything. It asserts a
row for each of the twelve stages, paired with the stage that would be silently empty without
it, so a gap names the stage rather than only the count.

Two operational rules are encoded in it, both learned by getting them wrong:

* **`indexStrategy` is `maintain`, never `defer`.** `defer` drops the global
  `claim_embeddings_hnsw_idx` and rebuilds it at the end. On a shared database that takes the
  index away from every other tenant, and an interrupted run leaves it gone. An earlier version
  used `defer`, was interrupted, and left the 2.4-million-row database with no HNSW index and a
  rebuild that had to be run by hand.
* **Both fixture URLs carry `max_parallel_workers_per_gather=0`.** Parallel workers need dynamic
  shared memory, and this repository's Compose service now sets `shm_size: 1gb` precisely
  because Docker's 64 MB default made a parallel index build fail with
  `dsm_impl_posix: could not resize shared memory segment` — a deployment fault that reads like
  a query fault.

## Recorded evidence

```
$ pnpm eval:perf explain \
    --tenant vm-a3-plan-capture-fixture --query "deployment window" --limit 10 \
    --subject "user:eng-00" --time-mode during \
    --from "2026-09-01T00:00:00.000Z" --to "2026-10-01T00:00:00.000Z" \
    --output reports/vm-a3-plan-capture.json --force
complete    yes
exit 0
```

| | |
| --- | --- |
| artifact | `reports/vm-a3-plan-capture.json` |
| SHA-256 | `5dc7ed6f3f9f787767d9fa74429f1e578def0bf5458b907974904f1f3cdad9db` |
| schema | `vm-a3.plan-capture.1` |
| PostgreSQL | 17.11 (Debian 17.11-1.pgdg13+2) |
| pgvector | 0.8.6 |
| migrations | 15 applied, latest `0015_claim_entity_index.sql` |
| application role | `veritymem_app` (`superuser=false`, `bypassrls=false`) |
| fixture | `vm-a3-plan-capture-fixture`, 400 claims, 336 accepted in the window |
| stages captured | **12** |
| stages missing | **0** |
| stages failed | **0** |
| unexpected duplicates | **0** |
| unlabelled statements | **0** |

The fixture's row counts, from `pnpm eval:perf fixture`:

```
claims 400 · accepted 336 · events 400 · spans 400 · claim_evidence 400
claim_embeddings 400 · claim_relations 8 · entity_aliases 117
claim_entities 769 · projection_versions 1 · accepted_in_window 336
```

Structural digests, one per stage:

```
scope_binding         5e353e55054fdc190f1ac9dba23fd14676f799e13fd461e24d381f057c0c79ae
lexical_channel       14872feaffed07cb9f1c45f0b64b6987ab530a2974ce78955e3a1e43a15e78ad
entity_channel        078025942ff6aefc407735717a5719ef82e78166e5fc3be8717bc02661ddb719
temporal_channel      fdceb1300ae03d00024b7f8d6445acce49adb24f6deeaee5cbba6379be9faf1b
relation_channel      0dbfd380cc88445d8b2574becaae9984a7185df4ed9e8e74c69e279bdd594086
dense_model_version   e4d3f885a1332064e82d2049d99064aaf33ca1e41571cb5cb414f4b24ec30516
dense_vector_search   9c66fdb5a578c408659ecde3958324720e5de2fcf47de70e7c8749e523b0dfa4
claim_hydration       ec8093bc721a53fa0140db2d5a67547cd8b44e86ba91b392d5e4e3cb36bd5335
claim_relations_read  6aad33b0ca8b80f137dda71b57e7e1d5595c47ebd19586e43f467d1e0910b20b
claim_evidence_read   c6ef17800aa00a912d5e521625168cdb180a8cc84b9bf3a9ca8b03183b4dd9d5
span_verification     cea9e5b1f2fa9cb2af1f9d5b6ba2f4eaedfb8d1650c464583f4be0c306ae49d9
projection_watermark  066ac88c5e79ce31fb58d0056af49efa488e57e9426585f455b3cb2080fd84cf
```

Parameter types, read from `pg_prepared_statements` rather than guessed from the JavaScript
values:

```
scope_binding         {uuid,text,uuid[],text[],text}
lexical_channel       {uuid,text[],timestamptz,timestamptz,text[],text,bigint}
entity_channel        {uuid,text[],timestamptz,timestamptz,text[],text[],bigint}
temporal_channel      {uuid,text[],timestamptz,timestamptz,text[],bigint,timestamptz,timestamptz}
relation_channel      {uuid,text[],timestamptz,timestamptz,text[],bigint}
dense_model_version   {uuid}
dense_vector_search   {uuid,text[],timestamptz,timestamptz,text[],vector,text,bigint}
claim_hydration       {uuid[]}      claim_relations_read  {uuid[]}
claim_evidence_read   {uuid[]}      span_verification     {uuid[]}
projection_watermark  {uuid}
```

`reports/` is gitignored, so the artifact is not committed. It is reproducible with the command
above; the digests are recorded here because, unlike the file hash, they are comparable between
runs.

## What is not in the artifact

Verified by inspecting the **entire serialized artifact**, plan trees included, not only the SQL
field — `EXPLAIN` puts bound values into `Filter` and `Index Cond`:

* the tenant id appears only as a 16-hex digest;
* the tenant slug, the principal id, the principal's held scope ids, the query text and the
  declared subjects are absent;
* no connection string, password or token marker;
* the query is recorded as `query_length` and a `query_digest`.

## What this does not do

* **It is not a latency measurement.** The timings describe a second, warm-cache execution and
  the artifact says so. The v0.1 p95 target is unaffected and remains unmet.
* **It does not capture writes.** `EXPLAIN ANALYZE` executes its statement, so the trace insert
  at the end of `compose` is deliberately skipped: explaining it would append to an
  append-only ledger twice.
* **It does not cover every plan in the system.** Deletion, retention, replay, the outbox worker
  and the commit gate are not retrieval stages and are not captured.
* **It does not profile the planner's own SQL.** `planQuery`'s scope resolution runs below the
  executor seam that `compose` wraps, so only `set_request_context` is explained.
* **The sanitizer is conservative in one direction.** When its scanner is unsure it emits a
  placeholder, so an expression may lose a detail a reader could have used. Over-sanitizing
  costs legibility; under-sanitizing publishes a tenant id.
