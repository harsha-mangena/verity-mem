# `@veritymem/perf` — the one-million-claim query benchmark

This package exists to answer one question with a number:

> **p95 non-LLM query latency at one million accepted claims.**

That is a v0.1 exit target in the specification, and the assessment records it as
unpassed with the note *"No reference machine, dataset or load report is published"*
and the completion rule *"Repeatable benchmark meets the target with hardware and
concurrency declared"*. This package is the instrument for that: a deterministic
synthetic corpus, a resumable bulk loader, a declared query mix, and a report that
records the hardware, the PostgreSQL and pgvector configuration, the index parameters,
the embedding dimensions, the concurrency, the cache state and the result-set size
alongside the measured percentiles.

**It does not close the block, and it says so in every artifact it writes.** The target
names a *published reference machine*. A run here declares the machine it ran on but is
not that machine, so it is evidence towards the block rather than closure of it. The
verdict logic in `src/report.ts` encodes that distinction rather than leaving it to
whoever writes the summary.

## What it measures — and the one thing it deliberately bypasses

**The measured path is the real one.** Every request goes through
`compose(deps, QueryRequest, { principal })` from `@veritymem/retrieval`, on an
RLS-bound application connection, as a principal that participates in the project scope.
Nothing is hand-written SQL. The cost of the planner's scope resolution, four retrieval
channels, rank fusion, evidence digest re-verification, the use policy and the query
trace are all inside the number, because they are all inside that call.

**The dataset is not.** A million rows through `Ledger.append` → `IngestPipeline` →
`CommitGate` would take hours, and it would measure the write path, which is not what
this target is about. `src/load.ts` therefore inserts the rows directly, under
`veritymem.set_system_context`, and writes **no `decisions` row and no `candidates`
row**. A reader must not be able to mistake this dataset for evidence that the gate ran.

So, plainly:

| | |
| --- | --- |
| **Measures** | The read path at scale: authorization, four channels, fusion, hydration, use policy, trace. |
| **Does not measure** | The write path. No extraction, no entailment, no promotion, no outbox. |
| **Does not measure** | Embedding quality. The backend is the deterministic hash embedder the repository defaults to, not a semantic model. |
| **Does not measure** | Ingest latency, projection lag, LLM cost or tokens, deletion, replay, retention, multi-tenant interference. |

## Reproducing the reported run

The reported run in `reports/perf-benchmark.json` was produced by exactly these
commands, on the machine recorded in that file's `host` block.

```bash
pnpm install -r
pnpm db:up                 # PostgreSQL 17 + pgvector 0.8.6 on 127.0.0.1:55432
pnpm migrate

# 1. Generate and load ~1.19M claims, of which ~1.0M are currently accepted.
#    Resumable: re-run the same command after an interruption and it continues.
pnpm eval:perf load --accepted 1000000

# 2. Measure. --skip-load because the corpus already exists.
pnpm eval:perf bench --skip-load --claims 1190477 --workload 600 --concurrency 4

# Reports:
#   reports/perf-benchmark.json   machine-readable, includes the verdict
#   reports/perf-benchmark.txt    human-readable summary
```

`pnpm eval:perf --help` lists every option. The ones that change the meaning of a run
are `--claims` / `--accepted`, `--concurrency`, `--workload`, `--limit` and `--anchor`;
all of them are recorded in the report.

### How long it takes

Measured on the reporting machine (Apple M1 Pro, 8 cores, 16 GiB, PostgreSQL 17.11 in
Docker with `shared_buffers = 16 MB`), from the run this package's report came from:

| Step | Time | Notes |
| --- | --- | --- |
| `load` phase 1–4 (events, spans, claims, claim_evidence) | ~6 min | ~18k events/s, ~13k claims/s, ~55k evidence rows/s |
| `load` phase 5 (`claim_embeddings`) | ~55 min | ~350 rows/s, dominated by online HNSW index maintenance |
| `load` phases 6–7 (relations, aliases) | ~1 min | |
| `bench` (cold + warm passes, 600 requests each) | see the report | scales with `--workload` |

The embedding phase is the long pole and it is index-bound, not code-bound: with
`m = 16, ef_construction = 64`, every insert walks the graph. Dropping the HNSW index,
loading, then rebuilding it in one pass is faster but changes what is measured, so the
loader does not do it. Budget an hour for a million-claim corpus, and use `status` to
watch progress:

```bash
pnpm eval:perf status --tenant perf-bench-veritymem-perf-v1-1190477
```

### Resuming an interrupted load

Nothing to do. Re-run the same command. Two mechanisms make it safe:

1. every primary key is derived from `(tenant, label, claim index)`, so a re-insert
   conflicts instead of duplicating;
2. a sidecar checkpoint in `.veritymem/perf/<tenant>.load-state.json` records the phase
   and index reached, so the loader does not re-derive rows it already wrote.

A lost checkpoint costs time, not correctness. Changing `--seed`, `--anchor`,
`--claims` (downward) or the embedding configuration invalidates the checkpoint
deliberately, because those change what the dataset *is*.

## What the report contains

`reports/perf-benchmark.json` records, all read from the machine or the database rather
than hardcoded:

* **Hardware** — CPU model, physical and logical core counts, performance/efficiency
  split where the platform reports one, RAM, OS and kernel version, architecture,
  whether the machine reports a battery.
* **Software** — Node version, `pg` driver version, full PostgreSQL version string,
  pgvector version.
* **PostgreSQL configuration** — `shared_buffers`, `work_mem`, `maintenance_work_mem`,
  `effective_cache_size`, `max_connections`, parallel worker limits,
  `random_page_cost`, `synchronous_commit`, `wal_level`, and the pgvector runtime GUCs.
* **Index parameters** — every HNSW index with its `m`, `ef_construction`, operator
  class and size, parsed from `pg_indexes`/`pg_get_indexdef`, plus the size of every
  index on the read path's tables.
* **Dataset** — tenant, corpus seed, anchors, row counts per table, the number of
  currently-accepted claims (read back from the database, because the target is stated
  in accepted claims), embedding model id and dimensions, the scope shape and how many
  scopes the caller reaches, the measured status mix, the measured distribution of
  valid-time interval widths, and a sample digest.
* **Workload** — the query mix with each shape's proportion and description, the
  concurrency, the result limit, the per-channel fetch limit, the warm-up count, and the
  read path.
* **Measurements** — per cache state, per time mode: n, min, p50, p90, p95, p99, max,
  mean, empty-packet fraction, and the per-shape breakdown; plus buffer read/hit deltas
  so the cache state is evidenced rather than asserted.
* **Verdict** — whether the target was met here, per-mode p95, and an explicit list of
  why the block is not closed and what the run does not measure.

## How latency is defined here

* Wall-clock around `await compose(...)`, in microseconds, on the issuing process. It
  includes pool checkout and the three transactions `compose()` opens.
* **Percentiles are nearest-rank** — `ceil(p/100 × n)`-th smallest. Interpolating
  between two samples produces a latency no request experienced.
* **Trace writes are inside the number**, because `compose()` writes a `query_traces`
  row and that cannot be disabled without editing `packages/retrieval`, which this work
  is explicitly not allowed to touch. The report says so rather than leaving a reader to
  discover it.
* **`cold` and `warm` are cache states of the measuring process's pool**: cold is a pool
  that has issued no query in this process, warm re-issues shapes already seen. Neither
  drops PostgreSQL's shared buffers or the operating system's page cache — that needs
  root, and pretending to have done it would be worse than saying so. Per-pass buffer
  read/hit counters are reported instead, so the reader can see which state was real.
* **A p99 from fewer than 200 samples is flagged in the report** as the largest
  observation rather than a percentile.
* **Empty packets are counted.** A workload that returns nothing measures nothing, and
  the report shows the empty fraction per mode so that cannot pass unnoticed.

## The query mix

Default, and exactly what the report prints (see `src/workload.ts`):

| Share | Shape | Mode | What it exercises |
| --- | --- | --- | --- |
| 30% | `current/free-text` | current | `websearch_to_tsquery` over prose |
| 12% | `current/entity` | current | entity alias resolution |
| 8% | `current/subject+relation` | current | declared subject, which enables the bounded relation channel |
| 15% | `as_of/recent-30d` | as_of | transaction-time read 30 days back |
| 10% | `as_of/historical-150d` | as_of | transaction-time read 150 days back |
| 10% | `during/1d` | during | valid-time window of one day |
| 8% | `during/7d` | during | valid-time window of seven days |
| 7% | `during/90d` | during | valid-time window of ninety days |

Every request has distinct query text, seeded from the corpus vocabulary. Repeating one
query ten thousand times would report a number no user experiences, because a repeat is
answered partly from caches a first-time query does not have.

## The corpus

`src/corpus.ts`. One claim per index, from `(seed, index)` alone — that is what makes
resume, idempotency and reproducibility possible.

* 40 user scopes inside one project, plus the project scope; the benchmark caller
  participates in the project scope and therefore reaches all 41. That is the widest
  realistic reach and the honest worst case for the pre-retrieval authorization filter.
* 21 of every 25 claims are accepted with an open interval; 4 are superseded with a
  closed one whose width is drawn from 1/3/7/14/30/90 days. Without the closed tail,
  `as_of` and `during` would return the same rows as `current` under a different
  predicate and the three modes would be three copies of one measurement.
* Every claim has a real evidence span at a non-zero offset inside its event payload,
  with a digest that re-verifies — so hydration exercises the verifying path, not the
  redacted one.
* 2% of claims carry a `contradicts` relation, so the conflict branch of hydration runs
  on a realistic fraction of returned packets.

## Files

| File | Role |
| --- | --- |
| `src/corpus.ts` | The generator: one integer index in, one claim plus its event, span and embedding text out. |
| `src/load.ts` | The resumable, batched bulk loader, and the statement of what it bypasses. |
| `src/workload.ts` | The declared query mix and the largest-remainder allocation of requests to it. |
| `src/metrics.ts` | Nearest-rank percentiles and the content statistics. |
| `src/host.ts` | Hardware, PostgreSQL version, configuration, index parameters and buffer counters. |
| `src/run.ts` | Orchestration: load, measure cold and warm, write the report. |
| `src/report.ts` | The report structure, the human summary, and the verdict logic. |
| `src/cli.ts`, `src/main.ts` | `load` / `bench` / `status`. |
| `src/perf.test.ts` | The instrument's own tests: corpus determinism, percentile method, mix allocation, verdict wording, and a 400-claim end-to-end load through the real read path. |

## Running the tests

```bash
node --experimental-strip-types --test packages/perf/src/perf.test.ts
```

The database-backed tests load 400 claims, not a million: they check a *shape* property
(that the loader writes rows the real read path can retrieve with verified digests), not
a size property. The size is what the reported run measures.

## The acceptance run

`scripts/verify.sh` has an optional, non-blocking step (`step 8b`) that measures the
corpus already in the database:

```bash
VERITYMEM_PERF=1 bash scripts/verify.sh
```

It is non-blocking on purpose. The target is stated against a published reference
machine, so a laptop missing 250 ms is not a release defect and a laptop meeting it does
not close block B7; making the acceptance run fail on either would get the step deleted.
The verdict is read from `reports/perf-benchmark.txt`, next to the hardware.
