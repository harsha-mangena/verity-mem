# `@veritymem/worker`

The extraction, gate and projection worker. It has no HTTP surface: it claims
messages from the Postgres outbox, runs the write path over each one, and writes
one JSON log line per batch.

Facts about this process that are load-bearing:

- **The ledger is the queue.** There is no second broker and no second source of
  truth. `Ledger.append` enqueues `extract.event` inside the transaction that wrote
  the event, and the ingest pipeline enqueues `project.claim` inside the transaction
  that accepted the claim.
- **No telemetry.** Logs go to stdout as JSON objects, one per line. Nothing is
  exported, sampled or phoned home.
- **No second retry mechanism.** `OutboxWorker.fail` records the error, applies
  exponential backoff (2^attempts seconds, capped at 300) and gives up at
  `max_attempts`. This process adds nothing on top of that.
- **RLS applies to background work.** Every processor runs inside a request
  transaction bound from the message's own `scope_ids` and `purposes`. A message
  missing either is an error, not a default.

## Run

```bash
pnpm db:up            # Postgres 17 + pgvector on 127.0.0.1:55432
pnpm migrate          # apply migrations
pnpm dev:worker       # long-running, watches the source

# or directly
node --experimental-strip-types apps/worker/src/main.ts
node --experimental-strip-types apps/worker/src/main.ts --once   # drain, then exit
```

`--once` drains every configured tenant and exits. It is the form a cron job or a
CI smoke test wants, and the only way to run this process to completion without
sending it a signal.

## Environment

Read from the process environment first, then `.env`, then `.env.local`, then the
default below. Defaults are development defaults and every one of them fails safe:
the gate falls back to a deterministic offline entailment check, never to "no
gate".

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://veritymem_app:veritymem_app@127.0.0.1:55432/veritymem` | Application connection. This role is **not** a superuser and does **not** have `BYPASSRLS`, so row-level security applies to this process exactly as it does to the API. |
| `WORKER_TENANT_SLUGS` | *(empty)* | Comma-separated tenant slugs this worker claims for. **Required in practice** — see the constraint below. An empty list logs `worker.no_tenants` and claims nothing forever. |
| `WORKER_BATCH_SIZE` | `25` | Messages claimed per tenant per cycle. |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Sleep between cycles when work is available. |
| `LEDGER_BLOB_DIR` | `<repo>/.veritymem/blobs` | Content-addressed store for payloads above the inline limit. |
| `GATE_ENTAILMENT_BACKEND` | `lexical` | `lexical` (deterministic offline stand-in, used by tests and CI) or `onnx` (quantised DeBERTa-v3 MNLI in-process). |
| `GATE_MODEL_PATH` | *(unset)* | ONNX artefact path. If `onnx` is selected and this is missing, the backend reports itself **unavailable** rather than substituting the lexical stand-in, so candidates go to `needs_review` instead of being accepted. |
| `GATE_MODEL_SHA256` | *(unset)* | Expected artefact digest, recorded on every decision so a gate swap is never silent. |
| `GATE_CONFIDENCE_THRESHOLD` | `0.5` | Model confidence floor below which an `entailed` verdict is not trusted for auto-acceptance. |
| `EMBEDDING_BACKEND` | `hash` | `hash` (deterministic, no model, no network) or `openai`. |
| `EMBEDDING_DIMENSIONS` | `1024` | Vector width. Must match the `vector(1024)` column. |
| `EMBEDDING_MODEL_ID` | `hash-ngram-v1` | Recorded per row in `claim_embeddings.model_id` and in `projection_versions`. |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | *(unset)* | Model extractor. With no base URL or model the worker runs deterministic extraction only and says so on every event (`no model extractor configured; deterministic extraction only`). |

The lexical entailment floor is **not** an environment variable. It comes from
`DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor`, because it is part of a
versioned policy document and a worker-local override would let a deployment run a
gate that no `decisions.policy_version` row describes.

## Log lines

Every line is a JSON object with `ts`, `level`, `service` (`veritymem-worker`) and
`msg`. Extra keys are sorted.

### `worker.start` — once, at startup

```json
{"ts":"…","level":"info","service":"veritymem-worker","msg":"worker.start",
 "batch_size":25,"embedding_backend":"hash-ngram-v1-1024","embedding_is_model_call":false,
 "entailment_model_sha256":null,"gate_backend":"lexical-overlap@1(floor=0.6)",
 "model_extractor":null,"poll_interval_ms":1000,"processors":["extract.event","project.claim"],
 "telemetry":"none","tenants":["demo-…"]}
```

`gate_backend` is the backend's own name, so a lexical stand-in is visible in the
log and cannot be mistaken for a verification model. `model_extractor: null` means
no model endpoint is configured, which is a supported deployment and not an error.

### `worker.batch` — once per cycle

```json
{"ts":"…","level":"info","service":"veritymem-worker","msg":"worker.batch",
 "claimed":3,"completed":3,"failed":0,
 "kinds":{"extract.event":2,"project.claim":1},
 "tenants_with_work":1,
 "projection_lag_pending":0,"projection_lag_oldest_available_at":null}
```

| Field | Meaning |
| --- | --- |
| `claimed` | Messages this cycle took a lock on. |
| `completed` | Messages whose processor returned and whose row was marked complete. |
| `failed` | Messages whose processor threw. The outbox recorded the error and scheduled a retry with backoff; this process does not retry them itself. |
| `kinds` | Per-kind breakdown of the claimed messages, so a stall is attributable to extraction or to projection. |
| `tenants_with_work` | How many configured tenants contributed a message. |
| `projection_lag_pending` | **Projection lag**: pending outbox rows (`completed_at IS NULL AND attempts < max_attempts`) across this worker's tenants. Rows that have exhausted `max_attempts` are excluded — those are a dead letter, not lag. |
| `projection_lag_oldest_available_at` | The oldest due time among pending rows. A timestamp far in the past means the queue is behind rather than momentarily empty. |

### `worker.no_tenants`, `worker.cycle_failed`, `worker.stopping`, `worker.stopped`, `worker.drained`

`worker.no_tenants` is a `warn` emitted at startup when `WORKER_TENANT_SLUGS` is
empty, with the reason. `worker.cycle_failed` is an `error` from the cycle itself
(database or configuration), not from a message — message failures are recorded on
the row by the outbox. `worker.stopping` carries `in_flight`, which says whether a
batch was still running when the signal arrived. `worker.drained` is emitted by
`--once` with the totals.

## Graceful shutdown

`SIGINT` and `SIGTERM` do the same four things, in this order:

1. stop claiming (`OutboxWorker.stop()`),
2. wait for the batch that is already handling messages,
3. close the connection pool,
4. log `worker.stopped`.

Closing the pool before step 2 would abort a transaction mid-gate, and claiming
after step 1 would take on work the process has already committed to abandoning.

## Two constraints worth knowing before you deploy this

### 1. The tenant list is required because of a defect in `packages/ledger`

`migrations/0009` enables row-level security on `outbox` with the policy
`tenant_id = veritymem.current_tenant_id()`. `OutboxWorker.claim()`,
`.complete()` and `.fail()` all run through `Db.systemQuery`, which by contract has
no request context bound — so `current_tenant_id()` is NULL, the policy evaluates
to FALSE, and the claim matches zero rows. The symptom is the worst kind: `runOnce`
returns `{claimed: 0, completed: 0, failed: 0}` and the worker looks healthy while
the queue never drains.

This app works around it by binding a tenant system context around each `runOnce`
call (`src/outbox-runner.ts`), which authorizes the same statements without
touching the package. The proper fix is a tenant scope inside
`OutboxWorker.claim/complete/fail`, which is a `packages/ledger` change owned
elsewhere. Two consequences are real and worth stating plainly:

- tenants must be enumerated in configuration, because there is no unbound read
  that can list them either (`tenants` is tenant-keyed too);
- throughput is bounded by tenants × batch size per cycle, not by batch size.

### 2. Shutdown is not crash safety

A `SIGKILL` between claiming and completing leaves messages locked until their
`locked_at` is reaped; no message is lost, because the outbox row is still pending,
but it will not be retried until the lock is considered stale. Extraction is
idempotent by construction (candidates are keyed on the event, the extractor and
the span set), so a redelivery cannot double-write a claim.
