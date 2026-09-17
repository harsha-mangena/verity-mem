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
│   ├── contracts/  DONE  frozen TypeBox/JSON schemas, reason codes, policy constants
│   ├── ledger/     DONE  append, hash chain, idempotency, spans, blobs, outbox, migrate
│   ├── gate/       DONE  entailment backends, span validation, commit gate
│   ├── policy/     DONE  re-exports the versioned policy documents
│   ├── claims/     TODO  lifecycle, bi-temporal queries
│   ├── retrieval/  TODO  planner, hybrid channels, packet composer
│   ├── model-adapters/ TODO OpenAI-compatible, Ollama, deterministic
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
