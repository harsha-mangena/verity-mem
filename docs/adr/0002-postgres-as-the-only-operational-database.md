# ADR 0002 — Postgres as the only operational database

**Status:** Accepted · v0.1

## Context

A memory layer with hybrid retrieval needs, on the face of it, four stores: a
relational store for claims, a vector index for dense retrieval, a full-text
index, and a graph for relations. The field's default answer is four systems or
the three that a graph database swallows.

Each additional store is an additional *source of truth* unless something proves
it is not. The question this ADR answers is not "can Postgres do it" but "which
of these stores can be wrong without the system being wrong".

`deploy/compose/docker-compose.yml` states the position in the service comment:
*"No Redis, no Neo4j, no separate vector store: every one of those would be a
second source of truth or a second operational dependency the spec deliberately
omits."*

## Decision

PostgreSQL 17 with pgvector is the only operational database in v0.1. Every
retrieval channel is a projection inside it:

| Channel | Implementation | Canonical? |
| --- | --- | --- |
| Lexical | `claims.search_tsv` (`TSVECTOR`) maintained by trigger `claims_search_tsv`, GIN index `claims_tsv_gin` | No — disposable |
| Dense | `claim_embeddings.embedding VECTOR(1024)`, HNSW index `claim_embeddings_hnsw_idx` | No — disposable |
| Entity | `entity_aliases` table | No — disposable |
| Temporal | `claims.valid_range TSTZRANGE GENERATED ALWAYS AS (tstzrange(valid_from, valid_to, '[)')) STORED`, GiST index `claims_valid_gist` | Yes, in the sense that the columns behind it are part of the claim record |
| Relation | `claim_relations` plus recursive CTEs | No — derivable from the relation rows |

Async work uses the same database. `outbox` plus `SELECT ... FOR UPDATE SKIP
LOCKED` in `OutboxWorker.claim()` (`packages/ledger/src/outbox.ts`) is the whole
messaging layer. The container pins the image and forces a deterministic
collation (`POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"`) because replay
equality depends on `ORDER BY` and FTS ranking being reproducible across
machines.

Two choices inside Postgres are worth naming:

- **HNSW over IVFFlat** for the dense index, because the corpus grows
  continuously and IVFFlat needs a training pass that a rebuild-heavy projection
  cannot rely on (`migrations/0001_core.sql`).
- **pgvector pinned** to `pgvector/pgvector:0.8.6-pg17-trixie`, with the extension
  created in `deploy/compose/initdb/01-extensions.sql` rather than in a migration,
  because extension creation needs privileges the migration role is not guaranteed
  to have.

## Consequences

- Projection lag is observable in one place and one unit: the `outbox` backlog.
  There is no cross-store consistency problem to reason about, because there is
  no second store.
- A rebuild is `DELETE` from projection tables plus a replay of the ledger. It
  does not need a distributed transaction, a dual-write, or a change-data-capture
  pipeline.
- Transactional correctness is free: the `redacted_at` write, the claim insert and
  the `outbox` enqueue for a single event all commit or all roll back.
- **Harder:** p95 latency at ten million claims is a single-database scaling
  problem, not a "shard the vector store" problem. The v0.1 exit target is p95
  non-LLM query under 250 ms at one million accepted claims; the v0.3 gate holds
  that at ten million. Neither is demonstrated in this repository yet.
- **Harder:** a graph-heavy workload that wants variable-length traversals will
  outgrow recursive CTEs before it outgrows Postgres, and the migration path is
  "revise this ADR", not "add Neo4j alongside".
- **Harder:** pgvector's index build is not free and is not incremental. A full
  projection rebuild reindexes.

## Alternatives rejected

**Neo4j as the relation store.** Rejected on three counts: Neo4j Community is
GPLv3, which is friction for downstream embedders of an Apache-2.0 library; a
graph store that is canonical encodes extraction errors as ontology, which the
spec names explicitly; and Postgres recursive CTEs are sufficient to validate the
relation model before paying for a second operational dependency.

**Redis for cache and coordination.** Rejected as a *requirement*. `memX`'s
last-write-wins over Redis is the comparison case in the spec: coordination state
is not belief. If Redis arrives later it is cache, never canonical.

**A dedicated vector store (Pinecone, Qdrant, Weaviate).** Rejected: vector search
is a projection of accepted claims. Making it a separate service creates a second
place where a deleted or revoked claim can survive, which turns the deletion
guarantee into a distributed-systems problem for no v0.1 benefit.

**Kysely as the query builder.** The spec's stack table names Kysely; the
repository uses raw SQL with `pg` and says so in `AGENT-BRIEF.md`. See ADR 0003
for why.
