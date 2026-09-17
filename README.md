# VerityMem

A proof-carrying memory layer for AI agents.

VerityMem is an open-source memory layer built around one failure it refuses to
reproduce: **uncontrolled status promotion**. A user statement, a model inference,
a tool result or a hostile document gets compressed into a durable "fact" without
preserving enough evidence, authority, scope or time semantics to decide whether it
should ever be trusted again. Retrieval then converts that lossy record into prompt
authority.

The primitive that is missing from every comparable system is not a better index. It
is a **commit boundary** between *something was observed* and *the system is allowed
to believe and reuse it*.

## The five properties everything else follows from

1. **Evidence is canonical; extracted memory is a projection.** Re-extraction never
   destroys the original. A model upgrade is a rebuild, not a migration.
2. **Promotion is explicit.** `proposed`, `accepted`, `disputed`, `superseded`,
   `rejected`, `revoked`, `expired` are first-class states, and no model call can set
   `status = accepted` — enforced in the database, not by convention.
3. **Authority and relevance are separate.** A highly relevant agent guess stays a
   guess. Similarity never confers truth, and there is no single `confidence` number
   anywhere in the API.
4. **Authorization runs before retrieval and again before use.** An unauthorized
   claim is never a retrieval candidate, so it cannot leak through a count, a timing
   or a summary.
5. **Every operation is testable and replayable.** A wrong answer localizes to
   admission, extraction, decision, indexing, retrieval, composition or action gating.

## What this is not

- Not another `add()`/`search()` SDK over embeddings. There is a deliberately
  Mem0-shaped facade in `packages/sdk-ts/src/facade.ts`, and it exists *only* as the
  instrument for a demand test — see below.
- Not a graph database. A graph is one query projection; making it canonical encodes
  extraction errors as ontology.
- Not an autonomous memory curator. Unrestricted agent writes are precisely the
  authority collapse this prevents.
- Not a promise of zero hallucination. Entailment is a filter, not a guarantee, and
  the known failure classes are documented rather than discovered by users.

## Quickstart

Requires Docker, Node 22+ and pnpm.

```bash
pnpm install -r
pnpm db:up          # PostgreSQL 17 + pgvector on 127.0.0.1:55432
pnpm migrate        # apply migrations
pnpm typecheck
pnpm test           # 82 tests against the real database
```

Copy `.env.example` to `.env` to change any default. The server, MCP server and
reference workload each have their own README; the end-to-end demonstration of the
whole thesis is `pnpm demo`.

## Repository

```
apps/
  server/                 Fastify API and MCP HTTP surface
  worker/                 extraction, gate and projection worker (Postgres outbox)
  reference-dev-agent/    multi-agent software-delivery workload, runnable end to end
packages/
  contracts/              frozen event/candidate/claim/decision/packet schemas
  ledger/                 append-only evidence ledger: hashing, idempotency, spans, blobs, outbox
  gate/                   entailment backends, span validation, the commit gate
  policy/                 versioned policy documents
  claims/                 claim reads, bi-temporal time predicates, the use policy
  retrieval/              policy-first planner, hybrid channels, composer, projections, retention, action gate
  model-adapters/         deterministic and model extractors, the ingest pipeline
  mcp-server/             MCP over stdio and Streamable HTTP
  sdk-ts/                 TypeScript client and the demand-test facade
  langgraph-js/           BaseStore plus the four adapter hooks, including the action gate
  ledgerbench/            the internal benchmark and its fixtures
  testkit/                shared test scaffolding
migrations/               plain SQL, checksummed, never edited after they are applied
fixtures/                 conformance, poisoning, deletion and LedgerBench streams
python/evals/             offline evaluation harness
docs/                     threat model, data model, policy cookbook, ADRs
```

## The one bet, and how to falsify it

Nobody has demonstrated that developers will accept **added write latency and
governance friction in exchange for correctness**. Mem0 wins adoption on a five-line
quickstart, and every architectural argument in this project is downstream of that
unvalidated demand assumption.

So the facade exists to test it cheaply: instrument whether users ever call
`explain`, and whether they tolerate the extra write latency without disabling the
gate. If nobody opens `explain` and everyone turns the gate off, the thesis is wrong
regardless of how good the benchmarks look.

The decisive product test is not *does the agent remember more?* but:

> Can an operator determine exactly why the agent remembered this, who authorised its
> scope, whether it was valid at the relevant time, what contradicted it, and whether
> the system truly removed it?

If `GET /v1/claims/{id}/explain` answers that in one call, in under a second,
VerityMem is meaningfully different. If it cannot, it is another retrieval layer with
extra steps.

## Honesty commitments

- Market the system as **traceable and bounded, never as verified**.
- Deletion is **proven by a residual scan**, never assumed. A job reports `verified`
  only when the scan returns zero across every declared store.
- The hash chain is **tamper-evident against accident, not tamper-proof against an
  operator with database access.** The documentation says so in those words.
- Self-graded isolation claims are worthless. "Zero cross-tenant retrievals" means
  nothing against fixtures we wrote; an external red team is budgeted for and not yet
  done.
- Publish the gate's false-negative rate. Any marketing language implying verification
  will be falsified by the first adversarial user, and deservedly.

`docs/threat-model.md` lists what is still open, including several things that are
deliberately not solved in v0.1. `SECURITY.md` covers disclosure.

## Licence

Apache-2.0. Every project VerityMem must interoperate with is Apache-2.0, and a memory
layer embedded in other people's applications has to be frictionless.

The entire trust-critical core stays open: ledger, gate, policy engine, claim model,
retrieval, deletion, MCP and the conformance suite. **No correctness feature will ever
move behind a paid tier** — that is the pattern this project exists to criticise.
