# ADR 0008 — Zero LLM calls on the default read path

**Status:** Accepted · v0.1

## Context

The obvious way to improve memory retrieval quality is to add a model: rerank the
candidates, synthesise an answer from them, or both. Every competitor does it,
because it measurably improves benchmark scores.

It also makes the read path's latency, cost and reproducibility depend on an
opaque model call. A memory layer is infrastructure other agents call *inside*
their own loop; making its p95 latency a function of a third-party endpoint, and
its output a function of an unpinnable model version, is a worse property than
slightly worse relevance.

The specification calls this *"the single most underrated commitment in the design
and the easiest to erode under feature pressure."*

## Decision

The default read path makes **zero** model calls, and every response says how many
it made.

`QueryRequestSchema` (`packages/contracts/src/packet.ts`) carries reranking behind
an explicit opt-in that defaults to false:

```ts
rerank: Type.Optional(
  Type.Object({ enabled: Type.Boolean({ default: false }) }, { additionalProperties: false }),
),
```

`MemoryPacket` carries `model_calls: Type.Integer({ minimum: 0 })` as a required
field, so a caller can assert on it and a test can prove the default is zero
rather than trusting the default value in a schema.

The signal is carried into the storage layer too: `query_traces.model_calls INT
NOT NULL DEFAULT 0` exists in `migrations/0001_core.sql` specifically so that the
per-query cost of a trace is recorded next to its results.

The same principle applies to the *write* path's budget, which is separate:
`IngestPipeline.ingest()` makes **at most one** extraction model call per
unstructured event, counted in `modelCalls` and returned as
`IngestResult.model_calls`. A model outage is caught and recorded as a note
(*"model extraction unavailable: ..."*) — the write is not failed and the
deterministic candidates still gate normally.

## Consequences

- Query latency is a function of Postgres, not of a network hop. The v0.1 exit
  target — p95 non-LLM query under 250 ms at one million accepted claims — is a
  database target.
- A packet is reproducible. Given a fixed ledger, projection watermark, policy
  version and code version, the same query returns the same packet. This is what
  makes `/v1/replay` and `ProjectionDigest` meaningful at all: if the read path
  called a model, replay equality would be unachievable and the whole
  deterministic-rebuild argument would collapse.
- Cost per query is zero. A read-heavy workload does not acquire a per-read bill.
- **Harder:** relevance quality is capped by lexical + dense + entity + temporal
  fusion. Paraphrase retrieval is weaker than a cross-encoder reranker would give.
  This is a deliberate trade, and the honest framing is that VerityMem is
  *traceable and bounded*, not that it retrieves better.
- **Harder:** every future feature request of the form "just add a reranker by
  default" has to be refused, and the refusal has to cite this ADR rather than
  taste. The specification's own roadmap defers a learned reranker to v0.3 and
  requires *"a strong reason"*.
- **Harder:** `MemoryPacket.signals` keeps five channels separate (`lexical`,
  `dense`, `entity`, `temporal`, `relation`) plus a `fuse_score`. Consumers who
  want one number will be tempted to add the channels up; `fuse_score`'s
  description says *"Relevance only — never a truth or confidence score"*, and
  there is no `confidence` field on `PacketClaim` for them to reach for instead.

## Alternatives rejected

**Rerank by default, opt out.** Rejected: a default that has been switched on is
the behaviour, and an opt-out flag is a compatibility promise that the default
will never change. The specification's kill criteria treat an eroded read path as
a failure, not a regression.

**A local cross-encoder reranker (no network).** The most credible alternative,
and it is not rejected on latency. It is rejected on reproducibility: it would
still make the packet depend on a model artefact, and the value of the default
path being model-free is that replay equality has no model input to pin. A
local reranker remains a legitimate opt-in.

**LLM synthesis of model-ready prose by default.** Rejected twice over: it adds a
model call, and it is the exact place where retrieved text gets concatenated into
a prompt. The specification requires model-ready prose to be optional and *"always
accompanied by machine-readable evidence"*, which is the opposite of making it the
default rendering.

**Embed the query with a hosted embedding model on every read.** Rejected as a
default. It is one model call per query, which is the thing this ADR forbids. The
config surface (`EMBEDDING_BACKEND=openai`) exists; the default is
`hash`/`hash-ngram-v1`, which is a deterministic local projection.
