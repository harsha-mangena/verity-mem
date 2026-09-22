# VM-A3 — channel-level plan capture: usage and evidence

VM-A3 adds `pnpm eval:perf explain`, which captures real PostgreSQL execution plans
for every VerityMem retrieval stage into one machine-readable artifact. This document
is the usage guide and the recorded evidence for the commit that introduced it.

The artifact is **diagnostic evidence, not a public API response**. Nothing here
changes the REST or MCP surface, and nothing here is a latency claim.

## Usage

```bash
pnpm eval:perf explain \
  --tenant <slug> \
  --query "deployment window" \
  --limit 10 \
  --subject "user:eng-00" \
  --output reports/vm-a3-plan-capture.json
```

| option | required | meaning |
| --- | --- | --- |
| `--tenant <slug>` | yes | tenant to capture against |
| `--query <text>` | yes | the query text to plan |
| `--limit <number>` | yes | `QueryRequest.limit`, 1..100 |
| `--output <path>` | yes | artifact path; refuses to overwrite without `--force` |
| `--subject <subject>` | no, repeatable | declared subject; the relation channel is planned only for these |
| `--time-mode <mode>` | no | `current` (default), `as_of`, `during`; only `during` makes the temporal channel issue a statement |
| `--database-url <url>` | no | read path connection, RLS-bound application role (default from `.env`) |
| `--migration-url <url>` | no | metadata and version reads, owner role (default from `.env`) |
| `--purpose <purpose>` | no | declared purpose (default `release_planning`) |
| `--principal <id>` | no | caller to capture as; must participate in the tenant. Omit to use the first participant found, which is reported |
| `--force` | no | overwrite an existing artifact |

Exit codes: `0` captured, `1` refused, `2` could not run.

### Why `--subject` and `--time-mode` matter

Both channels are conditional, and the artifact reports a conditional stage as
**missing** rather than inventing an entry for a plan nobody executed:

* `relation_channel` is planned only for caller-declared subjects — terms mined from
  the query text deliberately do not narrow the query;
* `temporal_channel` issues no statement unless the time mode is `during`.

Because a missing stage has two very different causes — *the query did not ask for
it* versus *it ran and was not captured* — the artifact records `time_mode` and
`declared_subjects` under `request`, and a regression test asserts that a missing
stage is explained by them.

## What it refuses, and why

Each refusal answers a question the artifact cannot answer for itself.

| condition | why it is a refusal |
| --- | --- |
| the tenant does not exist | the run would describe a tenant nobody asked about |
| no claims exist | eight empty plans that read as passing evidence |
| the application role bypasses RLS | plans would omit the policy predicate, so the artifact would certify that the boundary does not exist |
| the application role is a superuser | same |
| migrations are missing | the schema is not the one the artifact claims |
| the output exists without `--force` | an existing artifact cannot be replaced silently |
| no principal participates in the tenant | every plan would authorize nothing; the principal is discovered and reported rather than invented |

## How the plans are obtained

**The statements are the production ones.** No channel SQL is written in
`packages/perf`. `packages/retrieval` exposes one seam — `ComposeOptions.observer`,
with `withObservation` wrapping the `QueryExecutor` the channels already use — so
what is explained is what ran. The alternative considered and rejected was a second
copy of the channel SQL in the profiler, which would measure the profiler and drift
the first time a channel changed.

**The channel sees production behaviour.** The observed statement executes first and
its rows are returned untouched; the plan is captured afterwards with
`EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)` on the same statement and
parameters. Explaining first and letting the channel read the explain's rows is
wrong: `EXPLAIN ANALYZE` returns a plan, so a channel handed one would see "no rows"
and take its empty path — `denseChannel`'s model-mismatch branch, the empty-packet
branch, the abstention decision — and would report on the observability harness
rather than the read path.

The cost is stated in the artifact rather than hidden: captured `actual time` and
buffer counters describe a **second, warm-cache run**, and `capture.timing_note`
says so.

**Attribution is bound to the executor, not queued.** `runChannels` executes the
ordinary channels and the dense channel on two concurrent transactions. Two
attempts at a queue of pending stage names — global, then per lane — let the lanes
pair each other's names with each other's statements; a trace showed
`entity_channel` popping `dense_vector_search`. The stage name is now a property of
the executor a channel is handed, so concurrency cannot change the answer.

## Captured stages

Eleven statements from six retrieval stages and five hydration sub-queries:

```
scope_binding  lexical_channel  entity_channel  relation_channel
dense_model_version  dense_vector_search
claim_hydration  claim_relations_read  claim_evidence_read
span_verification  projection_watermark
```

Every retrieval plan runs as `veritymem_app` with a transaction-bound request
context. The owner connection is confined to preflight metadata and version reads —
a plan captured as the owner would not contain the row-level-security predicate.

## Recorded evidence

Command, against a disposable 400-claim tenant:

```
$ pnpm eval:perf explain --tenant vm-a3-capture-test --query "deployment window" \
    --limit 10 --subject "user:eng-00" --output reports/vm-a3-plan-capture.json
artifact    /Users/venom/verity-mem/reports/vm-a3-plan-capture.json
exit 0
```

| | |
| --- | --- |
| artifact | `reports/vm-a3-plan-capture.json` |
| SHA-256 | `da043d93dfb5eb36fd6a960949bc61636481c83098c3dcee74d5861aac96d29d` |

**The whole-file hash changes on every run and the digests do not**, which is the
distinction the digest exists to make. `generated_at`, `commit` and every captured
timing differ between two runs of the same command on the same data, so the file
hash is not a fingerprint of the plans. The eleven `structural_plan_digest` values
below *are* stable: two consecutive runs produced byte-identical digests for all
eleven stages while the file hash moved from `9ee311a7…` to `da043d93…`. A change in
a digest is therefore a change in plan shape, and a change in the file hash is not
evidence of anything.
| schema | `vm-a3.plan-capture.1` |
| PostgreSQL | 17.11 (Debian 17.11-1.pgdg13+2) |
| pgvector | 0.8.6 |
| migrations | 15 applied, latest `0015_claim_entity_index.sql` |
| application role | `veritymem_app` (`superuser=false`, `bypassrls=false`) |
| corpus | 400 claims |
| stages captured | 11 |
| stages failed | 0 |
| stages missing | `temporal_channel` — explained by `request.time_mode = "current"` |

Structural digests, one per stage:

```
scope_binding         21332fb90187c8dbc4377adf5b12750beaef059fae3c02446f8933618ac3df60
lexical_channel       d0d7002829a1207d515a36d9d79f554ead3f80417b8cd6ee44add3c197bd8620
dense_model_version   8c66b6dc4874c5bde6226a2e63ea88522e786f89935b4c80a11043a842a6d53a
entity_channel        4e0195a566c5b97aa70cd7cb9a4ae88b83e9d1098f6a76c73daedf3bc30102c9
relation_channel      467818dadccb853c165c83f33e7385f80a046ad842b851716589c0c7aecaef1d
dense_vector_search   065c62b557d9742f6f2efe82808e3d02dd965ad93a715361a400e4a813930f90
claim_hydration       0bab01f95547756b78800e481ede6d31fccef9c045f8fef347aa5fdace8a48af
claim_relations_read  32b73a3610042f9f48c5b107c8a070eb06c3eed6ef8e4307c3af042e7b8a1739
claim_evidence_read   9fffdba42befedfb6e0810e41af615729eeaae141da284958242d2d947a1c75a
span_verification     1f8de258faa45f15ef0b72231356eff98d03566c4244f9944556eb9e2c8b0178
projection_watermark  890a040970367f07e61e25c8407e8308f5bdf15d92de0f0423050c8287a3e3c4
```

`reports/` is gitignored, so the artifact is not committed. It is reproducible with
the command above against any populated tenant; the digests are recorded here so a
change is visible even without the file — and, unlike the file hash, they are
comparable between runs.

## What is not in the artifact

No connection string, credential, authorization token, principal identifier, tenant
slug or id — the tenant appears as a 16-hex digest — and no raw query text: the
request records `query_length` and a `query_digest` instead. Statement literals are
replaced with `?` by `sanitizeSql`, so the SQL is the statement's *shape*. A
regression test asserts these absences against the serialized artifact.

## What this does not do

* **It is not a latency measurement.** The timings in it describe a second,
  warm-cache execution and say so. The v0.1 p95 target is unaffected by this work
  and remains unmet.
* **It does not capture writes.** `EXPLAIN ANALYZE` executes its statement, so the
  trace insert at the end of `compose` is deliberately skipped: explaining it would
  append to an append-only ledger twice.
* **It does not cover every plan in the system.** Deletion, retention, replay, the
  outbox worker and the commit gate are not retrieval stages and are not captured.
* **It does not profile the planner's own SQL** — `planQuery`'s scope resolution
  runs below the executor seam that `compose` wraps, so only `set_request_context`
  is explained. Capturing the planner's queries is a separate change.
