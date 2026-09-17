# ADR 0001 — Evidence ledger as canonical store; projections disposable

**Status:** Accepted · v0.1

## Context

A memory layer has to answer "why does the system believe this?" months after the
write. Two shapes are available. Either the *derived* artefact is canonical — an
extracted claim, an embedding, a graph edge — and the source is a citation
attached to it; or the *source* is canonical and every derived artefact is
rebuildable output.

The first shape is what the field ships, and it has three failure modes that are
all the same failure at different timescales. When an extractor improves, the old
extraction is a migration problem rather than a rebuild. When an extraction is
wrong, the error is baked into the object everything else references. When a
document is corrected, there is no path from "the bytes changed" to "the beliefs
that rested on those bytes are suspect", because the bytes are the citation, not
the record.

`migrations/0001_core.sql` opens with the constraint: *"There is no `memory`
table. Evidence, candidates, claims and decisions are separate objects with
separate lifecycles, and only `events` is immutable."*

## Decision

`events` is the canonical store. It is append-only, ordered per stream by a
sequence number, content-hashed, and hash-chained. Everything else —
`claim_candidates`, `claims`, `claim_evidence`, `claim_relations`, `decisions`,
`claim_embeddings`, `entity_aliases`, `search_tsv` — is derived and disposable.

Enforcement, in order of strength:

| Property | Enforced by | File |
| --- | --- | --- |
| Events are never mutated | `veritymem.reject_event_mutation()` via trigger `events_append_only` (`BEFORE UPDATE OR DELETE ... FOR EACH ROW`) | `migrations/0002_integrity_and_rls.sql` |
| Events are never deleted, even by a zero-row DELETE | `veritymem.reject_event_delete()` via trigger `events_no_delete` (`FOR EACH STATEMENT`) | `migrations/0004_event_delete_guard.sql` |
| Claims are never deleted | `veritymem.reject_claim_delete()` via trigger `claims_no_delete` | `migrations/0002_integrity_and_rls.sql` |
| Evidence spans are immutable | `veritymem.reject_span_mutation()` via trigger `evidence_spans_immutable` | `migrations/0002_integrity_and_rls.sql` |
| Payload bytes may only be cleared by retention redaction | the `NEW.redacted_at IS NULL` branch of `reject_event_mutation()` | `migrations/0002_integrity_and_rls.sql` |
| Only one payload holding place exists | constraint `events_payload_present` | `migrations/0001_core.sql` |

The append path (`Ledger.append` in `packages/ledger/src/ledger.ts`) allocates the
per-stream sequence under a row lock in `streams`, so a stream's order is not a
permissive upsert race.

The single permitted mutation to a ledger row is retention redaction, which clears
`payload` and `payload_ref` and sets `redacted_at` while preserving `content_hash`,
`prev_hash`, `link_hash` and the row's existence. This is deliberate: a residual
scan has to be able to testify that the event existed and when it was removed.

## Consequences

- A model upgrade is a rebuild, not a migration. `/v1/replay` is meaningful
  because the input to a rebuild is the ledger, not the previous projection.
- `GET /v1/claims/{id}/explain` can quote the actual bytes, and the quote is
  re-derived on every read rather than cached (`Ledger.verifySpan`).
- **Harder:** every read that returns a claim pays a payload fetch and a SHA-256
  per span. Caching that verification is exactly the silent drift the design
  exists to prevent, so the cost is not recoverable by the obvious optimisation.
- **Harder:** storage grows monotonically. There is no compaction path, because
  compaction of an append-only log is deletion with extra steps. Blob reclamation
  is left as a separate operator task that `packages/ledger/src/blobs.ts`
  explicitly refuses to have an API for.
- **Harder:** a payload larger than `Ledger.inlinePayloadLimit` (default 8192
  bytes, `LEDGER_INLINE_PAYLOAD_LIMIT`) goes to content-addressed blob storage, so
  span resolution acquires a second failure mode — a missing blob — that
  `Ledger.verifySpan` reports as `{ status: "missing", reason: "event_not_found" }`
  rather than raising.

## Alternatives rejected

**Claim store canonical, evidence as citation.** Rejected: this is precisely the
"provenance resolves to chunk IDs, not spans" pattern the spec names as the
whitespace VerityMem exists to fill. It also makes re-extraction a destructive
operation.

**Ledger as a WAL beside a canonical claim store.** Rejected: two sources of truth
means the replay guarantee is only as good as the weaker one, and there is no
defensible answer to "which one is wrong?" when they disagree.

**Event-sourced claims with snapshots as the read path.** Not rejected on
principle — snapshots are projections and are legitimate — but rejected as the
*canonical* store. A snapshot that can be promoted to canonical is an extraction
error waiting to become an ontology.
