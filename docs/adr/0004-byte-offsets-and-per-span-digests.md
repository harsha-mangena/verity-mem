# ADR 0004 — Byte offsets plus per-span digests, verified on every read

**Status:** Accepted · v0.1

## Context

A claim has to cite the exact text that establishes it. Three provenance
granularities were available:

- **Chunk id** — cite the retrieval chunk the claim came from.
- **Character offsets** — cite `[start, end)` in characters.
- **Byte offsets plus a digest of the slice** — cite `[start, end)` in bytes and
  store the SHA-256 of those bytes with the span.

Chunk ids are what the field ships and they are not provenance. A chunk is a
retrieval artefact: its boundaries move when the chunker changes, it does not
survive a re-ingest, and "the claim came from somewhere in this 500-token block"
cannot be checked against anything. A citation that cannot be *checked* is a
citation that will eventually be wrong without anyone noticing.

Character offsets are a subtly worse bug than they look. JavaScript string
indexes are UTF-16 code units. A span computed as `content.indexOf(...)` disagrees
with a span computed over bytes for any string containing a non-BMP character,
which is to say for any string containing an emoji, most CJK, or a flag. The
disagreement is silent, it is off by a small amount, and it produces a quote that
is *almost* right.

## Decision

Spans are half-open byte ranges into the exact stored payload, each carrying a
SHA-256 digest of its own slice.

```sql
CREATE TABLE evidence_spans (
  span_id     UUID PRIMARY KEY,
  event_id    UUID NOT NULL REFERENCES events(event_id),
  start_off   INT NOT NULL,
  end_off     INT NOT NULL,
  selector    TEXT,
  span_digest BYTEA NOT NULL,   -- SHA-256 over the payload slice [start_off, end_off)
  quote       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_off > start_off),
  CHECK (start_off >= 0)
);
CREATE UNIQUE INDEX evidence_spans_identity_idx
  ON evidence_spans (event_id, start_off, end_off, COALESCE(selector, ''));
```

Four rules follow:

- **Digests are computed over bytes, not over a re-derived string.**
  `Ledger.writeSpan()` (`packages/ledger/src/ledger.ts`) does
  `payload.subarray(span.start, span.end)` on a `Buffer` and hashes the result.
  The offsets are checked against `payload.byteLength` before the slice is taken.
- **Verification happens on every read.** `Ledger.verifySpan()` recomputes
  `sha256Hex(payload.subarray(span.start, span.end))` and compares. It is called
  from `Ledger.verifySpans()` on the batch path and from
  `CommitGate.verifyEvidence()` on every gate evaluation. The doc comment on
  `verifySpan` states the policy: *"A cached verification would be exactly the
  silent drift the design exists to prevent."*
- **The digest is distinct from the event `content_hash`.** The content hash says
  "this payload is unchanged". The span digest says "the bytes at these offsets are
  unchanged". A migration, a re-encoding or a partial rewrite can preserve the
  first and break the second.
- **Offsets are converted, never guessed.** `codeUnitToByteOffset()` in
  `packages/model-adapters/src/extractor.ts` walks the string and counts UTF-8
  bytes; `spanFromMatch()` builds every deterministic extractor span through it.
  The model extractor prompt (`EXTRACTION_SYSTEM_PROMPT`) instructs the model to
  *"Compute them by counting BYTES, not characters"* and the parser rejects any
  span whose `end > Buffer.byteLength(content, "utf8")`.

Span identity is `(event_id, start_off, end_off, COALESCE(selector, ''))`, so
writing the same span twice is idempotent rather than a duplicate. `Ledger.writeSpan`
relies on the unique index and then re-reads the winner, which is also how it stays
safe under concurrent writers.

## Consequences

- A retrieval result can be checked: the packet's `quote` is re-derived from
  current payload bytes and `digest_ok` is computed per read
  (`ClaimEvidenceRef` in `packages/contracts/src/claim.ts` documents this as
  *"Recomputed on this read, not cached"*).
- Payload drift produces a specific, named failure rather than a wrong citation.
  `SpanVerification` distinguishes `ok`, `missing`, `redacted`, `digest_mismatch`
  and `out_of_bounds`, and each maps to a distinct reason code
  (`span.resolved`, `span.unresolvable`, `span.event_redacted`,
  `span.digest_mismatch`, `span.out_of_bounds`).
- **Harder:** a `digest_mismatch` has no repair. The span is immutable by trigger,
  the event is immutable by trigger, and the correct response is to treat the
  claim as unusable until it is re-extracted from the current bytes. There is no
  "recompute the digest" operation and there must not be one.
- **Harder:** every read that returns evidence costs one event fetch and one
  SHA-256 per span. `Ledger.readEvents()` batches by event id so the read path does
  not issue one query per claim, but the hashing is unavoidable.
- **Harder:** `selector` exists for structured and DOM payloads and is stored, but
  no code in this repository interprets it. It is a reserved column. A claim
  against a JSON payload currently cites the byte range of the JSON text, which is
  correct and less ergonomic than citing a pointer would be.

## Alternatives rejected

**Chunk ids.** Rejected: not checkable, not stable across a chunker change, and it
is the specific weakness the spec attributes to `cognee` ("provenance resolves to
chunk IDs, not spans").

**Character offsets.** Rejected: silently wrong for non-ASCII content and
inconsistent between the extractor (which sees a JS string) and the store (which
holds bytes). The test *"counts offsets in bytes, not UTF-16 code units"*
(`packages/ledger/src/ledger.test.ts`) exists specifically to keep this decision
from regressing.

**Whole-payload provenance only.** Rejected: "this claim came from this document"
cannot distinguish a claim that is entailed by one sentence from a claim that the
document contradicts elsewhere. The gate needs the slice.

**Page or line numbers.** Rejected: they are a rendering of an offset, they change
with the renderer, and they are not a byte range.
