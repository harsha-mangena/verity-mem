# AGENT BRIEF — VerityMem v0.1

Read this before touching anything. It is the shared context for every agent
working in this repository.

## Where the requirements come from

The authoritative specification is a single merged document. **Read it in full
before writing anything**:

    /Users/venom/.dsh/attachments/v1/files/7f/7fb79fc24d1277cc1cb3e707947a440c129d80b28317524b85f5b39f7fa17ba1/VerityMem — MVP Specification (merged).md

It is read-only. Do not copy it into the repository and do not paraphrase it into
documentation — documentation should *implement* it, not restate it.

## What this project is

A proof-carrying memory layer for AI agents. The canonical store is an append-only
evidence ledger; extractors *propose* typed claims with exact evidence spans;
claims become believable only through a versioned policy commit gate. Vector,
full-text and relation indexes are disposable projections, rebuildable from the
ledger.

Five hard differentiators, in the spec's own words. Every design decision must be
traceable to one of them:

1. Evidence is canonical; extracted memory is a projection.
2. Promotion is explicit. No model call can set `status = accepted`.
3. Authority and relevance are separate. Similarity never confers truth.
4. Authorization runs before retrieval and again before use.
5. Every operation is testable and replayable.

## Current repository state

```
/Users/venom/verity-mem
├── apps/
│   ├── server/                 # Fastify API + MCP HTTP          (routes in progress)
│   ├── worker/                 # extraction, gate, projections    (in progress)
│   └── reference-dev-agent/    # software-delivery demo           (not started)
├── packages/
│   ├── contracts/  DONE  frozen schemas, reason codes, policy, vocabulary drift test
│   ├── ledger/     DONE  append, hash chain, idempotency, spans, blobs, outbox, system context
│   ├── gate/       DONE  entailment backends, span validation, commit gate
│   ├── policy/     DONE  re-exports the versioned policy documents
│   ├── claims/     DONE  reads, bi-temporal time predicates, use policy
│   ├── retrieval/  DONE  planner, channels, composer, projections, retention, action gate
│   ├── model-adapters/ DONE deterministic + model extractors, ingest pipeline
│   ├── mcp-server/ TODO  stdio + Streamable HTTP
│   ├── sdk-ts/     TODO
│   └── langgraph-js/ TODO BaseStore + four hooks incl. the action gate
├── packages/testkit/ DONE  shared test scaffolding
├── migrations/     DONE  0001..0006 (schema, RLS, chain, predicate fixes)
├── fixtures/       TODO  conformance/, poisoning/, deletion/
├── python/evals/   TODO  LedgerBench harness (offline only)
├── docs/           TODO  threat-model.md, data-model.md, policy-cookbook.md, adr/
├── scripts/        migrate.ts
├── SECURITY.md     TODO
├── CONTRIBUTING.md TODO
└── LICENSE         TODO (Apache-2.0)
```

## The API surface that exists today

These are real, typechecked, and covered by 70 passing tests. Build on them; do not
reimplement them.

```ts
// packages/ledger — the canonical store
import { Db, Ledger, FilesystemBlobStore, systemClock, systemIds, loadEnv,
         resolveTenantId, OutboxWorker, runMigrations } from "@veritymem/ledger";

const env = loadEnv();
const db = new Db({ connectionString: env.databaseUrl });
const ledger = new Ledger({ db, blobs: new FilesystemBlobStore(".veritymem/blobs"),
                            clock: systemClock, ids: systemIds });

await ledger.append({ stream_id, idempotency_key?, origin, actor_id, scope, occurred_at, content })
  // -> { event_id, seq, recorded_at, scope, content_hash, prev_hash, deduplicated, extraction_queued }

// EVERY tenant read/write must be bound. There is no unbound overload.
await db.withRequest({ tenant, principal, scopeIds, purposes, action? }, async (executor) => { ... });
// Tenant-wide maintenance only:
await db.withSystemContext({ tenant, actor }, async (executor) => { ... });
```

```ts
// packages/model-adapters — the write path
import { IngestPipeline, DETERMINISTIC_EXTRACTORS, ModelExtractor,
         OpenAiCompatibleAdapter, OllamaAdapter, DeterministicStandInAdapter } from "@veritymem/model-adapters";

const pipeline = new IngestPipeline({ db, ledger, gate, ids, clock,
  deterministicExtractors: DETERMINISTIC_EXTRACTORS, modelExtractor /* | null */ });
await db.withRequest(binding, (ex) => pipeline.ingest(ex, event));
// -> { event_id, admission, candidates, decisions, model_calls, extractor_versions, notes }
```

```ts
// packages/gate — the commit gate
import { CommitGate, LexicalEntailmentBackend, createOnnxEntailmentBackend } from "@veritymem/gate";

const gate = new CommitGate({ db, ledger, ids, clock, entailment, policy });
await gate.evaluate(executor, candidateForGate);
// -> { decision_id, outcome, reason_codes, claim_id, policy_version, evidence, detail }
```

```ts
// packages/retrieval — the read path, projections, retention, the action gate
import { compose, evaluateAction, forget, rebuildProjections, projectClaim,
         digestLexicalProjection, HashEmbeddingBackend, createProjectionProcessor,
         planQuery, resolveScopes } from "@veritymem/retrieval";

const deps = { db, ledger, embeddings, ids, clock, gateBackend };

// The read path. Zero model calls unless the embedder is hosted.
await compose(deps, { tenant_id, query, scope, purpose, time?, action_risk?, limit? },
              { principal });
// -> { packet: MemoryPacket, plan, channels, fused, candidates_denied_by_authz }

// The enforcement point. Call before every medium- or high-risk side effect.
await evaluateAction(deps, { action, action_risk, scope, purpose, claim_ids, trace_id? },
                     { principal });
// -> { allowed, decision, reason_codes, claims[], policy_version, evaluated_at }

// Retention, with a verified manifest and a residual scan.
await forget({ db, ledger, ids, clock }, { tenant_id, tenant_slug, subject_or_scope, mode, reason });
```

```ts
// packages/claims — claim reads and the use policy
import { listClaims, readClaim, readClaims, readRelations, evaluateUse,
         timePredicate, ageInDays, render } from "@veritymem/claims";
```

```ts
// packages/contracts — frozen schemas, reason codes, policy documents
import { MemoryPacketSchema, EventAppendRequestSchema, QueryRequestSchema,
         ActionGateRequestSchema, REASON_CODES, DEFAULT_COMMIT_POLICY,
         DEFAULT_USE_POLICY_VERSION, DEFAULT_ACTION_POLICY_VERSION,
         RISK_TO_ALLOWED_USE, RISK_TO_MAX_EVIDENCE_AGE_DAYS } from "@veritymem/contracts";
```

### Behaviour you must not accidentally change

- `compose()` returns `decision: "clarify"` with an empty claim list when the
  caller reaches no scope. It never discloses whether the scope exists.
- `evaluateAction()` re-reads claims and re-verifies evidence digests on every
  call. It does not accept a packet, and it must not be given one.
- `forget()` only reports `verified` when its residual scan returns zero, and the
  scan runs inside `withSystemContext`. If you change that binding, the scan
  silently proves nothing while still reporting success.
- `OutboxWorker` throws on a message that carries no `scope_ids` or no `purposes`.
  That is deliberate: the previous behaviour was a silent no-op.
- The high-risk action threshold is `verified_record`. A `user_self_report` or a
  `tool` observation yields `verify` at high risk and the action is refused.

## How to run things

```bash
pnpm install -r
pnpm db:up                      # Postgres 17 + pgvector on 127.0.0.1:55432
pnpm migrate                    # apply migrations
pnpm typecheck                  # tsc --noEmit, must be clean
pnpm test                       # node:test against the real database
```

Environment defaults are in `.env.example`; copy to `.env` if you need to change
one. Tests run as the `veritymem_app` role, which is **not** a superuser and does
**not** have `BYPASSRLS`, so row-level security is load-bearing in tests. Tests
isolate by generating a fresh tenant slug per context, never by deleting rows —
the ledger is append-only and a suite that can delete events is testing a
different system than the one that ships.

## Conventions this repository enforces

- **TypeScript, ESM, Node 22+.** Relative imports carry the `.ts` extension.
  `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are all on.
- **Tests use `node:test`**, not Jest or Vitest. `import { describe, it, before,
  after } from "node:test"`. Run a single file with
  `node --experimental-strip-types --test path/to/file.test.ts`. Set
  `MIGRATION_DATABASE_URL=postgres://verity:verity@127.0.0.1:55432/veritymem`
  when a test needs a privileged connection.
- **Every exported function has a doc comment explaining why it exists**, not what
  it does. The code says what it does.
- **Comments state constraints and non-obvious decisions.** A comment that
  restates the next line is noise; a comment that records why the obvious
  alternative was rejected is the most valuable thing in the file.
- **No new runtime dependencies without a documented reason.** The stack is
  fixed by the spec: Fastify, TypeBox, Kysely-style SQL (raw SQL with `pg`), pgvector,
  Postgres outbox, official MCP TypeScript SDK, ONNX Runtime Node for entailment.
- **Never claim a property the code does not have.** If something is a
  deterministic stand-in rather than a real implementation, say so in the code,
  in the docs, and in the API response.

## Non-negotiables

- **No model call may set `claims.status`.** Only the commit gate promotes.
- **Authorization before retrieval.** An unauthorized claim must never be a
  retrieval candidate, and must not appear in counts, timings or summaries.
- **Never emit a single confidence number.** Six dimensions stay separate:
  extractor confidence, evidence entailment, authority class, freshness/expiry,
  conflict state, policy use decision.
- **Zero LLM calls on the default read path.** Reranking and synthesis are opt-in.
- **Deletion is proven by residual scan, never assumed.**
- **Retrieved memory is passed as structured data with provenance, never spliced
  unescaped into a system message.**

## Two bugs already found and fixed — do not reintroduce them

1. **Empty purpose was treated as "unrestricted".** A row whose scope had no
   purpose matched every caller. Purpose is a hard boundary: no purpose means
   unreachable, and a scope must declare at least one.
2. **Two permissive RLS policies combined with OR let the cheaper clause win.**
   A tenant clause and a scope clause meant a row was visible when *either* held.
   There is now one predicate, `veritymem.row_authorized(tenant, scope)`, used by
   every scoped table, and it wraps the result in `COALESCE(..., FALSE)` because a
   policy expression evaluating to NULL is treated as a pass by PostgreSQL.

If you add a table with tenant data, it needs `ENABLE ROW LEVEL SECURITY` and a
policy on that predicate. Add a migration that proves the boundary with a
self-check, in the style of `migrations/0005` and `0006`.

## Reporting back

When you finish, report:
- files created or modified, with paths;
- the exact commands you ran and their observed output (not a summary of what you
  expect them to do);
- anything you could not verify, stated plainly;
- any place where the specification and the code disagree.
