# ADR 0007 — `accept_limited_scope` narrowing as the default failure mode

**Status:** Accepted · v0.1

## Context

The scope-broadening failure is the one that turns a memory layer into a
liability:

> "Alice said she might prefer X for this trip" must not become "Alice prefers X".

A candidate arrives with a *requested* scope — the scope the extractor thinks the
claim deserves. Its evidence has an *actual* scope — the scope of the event the
span came from, which is the only scope any human or system actually authorised.
When the requested scope is wider than the evidence's scope, the candidate is
making a claim about the world that no one granted it the authority to make.

There were three defensible responses: reject the candidate, accept it at the
requested scope and flag it, or accept it at the evidence's scope.

## Decision

A candidate whose requested scope exceeds its evidence's scope is **accepted at
the narrower scope**, not rejected and not accepted-and-flagged. This is the
`accept_limited_scope` outcome.

`CommitGate.evaluate()` reaches it in the fourth branch of the decision cascade
(`packages/gate/src/commit-gate.ts`):

```ts
} else if (
  integrityOk && entailmentOk && authorityStrong &&
  contradicting.length === 0 &&
  !containment.contained &&
  requestedScope.tenant_id === eventScope.tenant_id
) {
  outcome = "accept_limited_scope";
  reasonCodes.push(REASON_CODES.SCOPE_NARROWED_TO_EVENT);
}
```

and persists it by overriding the scope the claim is written at:

```ts
const acceptedScopeId =
  outcome === "accept_limited_scope" ? candidate.event_scope_id : candidate.requested_scope_id;
```

The containment test is `CommitGate.scopeContainment()` — containment, **not
overlap**. Per dimension (`project`, `user_id`, `agent_id`, `session_id`):

- requested is `NULL` and authority is not → **not contained** (requested is wider)
- requested is not `NULL` and authority is `NULL` → contained but **narrower**
- both non-`NULL` and different → **not contained**
- identical → contained

and on purpose: a requested purpose the authority scope was not admitted for makes
the candidate not contained (`scope.purpose_broadened`); an authority purpose the
request does not carry makes it narrower.

Two things make narrowing the *default* rather than a special case:

1. **The extractor interface cannot request a wider scope and have it honoured.**
   `Proposal.requested_scope` is documented in
   `packages/model-adapters/src/extractor.ts` as *"A scope narrower than the
   originating event's scope. An extractor may only ever narrow"*, and
   `IngestPipeline.resolveRequestedScope()` defaults to the event's own scope and
   falls back to the event's dimensions for anything the proposal omits.
2. **The gate re-checks containment rather than trusting the pipeline.** The
   pipeline proposes; the gate decides. The `requestedScope.tenant_id ===
   eventScope.tenant_id` guard means narrowing is never used to move a claim
   across a tenant boundary — a cross-tenant request fails containment and falls
   through to `needs_review`, not to a narrower accept.

Reason codes distinguish the three scope outcomes so an operator can see which
happened: `scope.within_event_scope`, `scope.broader_than_event_scope`,
`scope.outside_event_scope`, `scope.purpose_broadened`,
`scope.narrowed_to_event`.

## Consequences

- **The failure mode is losing recall, not gaining reach.** A claim that should
  have been tenant-wide ends up project-scoped and is invisible to a tenant-wide
  query. That is a visible, diagnosable under-answer. The opposite failure — a
  claim that should have been session-scoped becoming tenant-wide — is invisible
  until it is a disclosure.
- **Narrowing is recorded, not silent.** `GateResult.detail.scope` carries
  `requested_scope_id`, `event_scope_id`, `accepted_scope_id`, `broadened_purposes`
  and `narrower`, and `SCOPE_NARROWED_TO_EVENT` is written into
  `decisions.reason_codes`. `GET /v1/claims/{id}/explain` is supposed to surface
  the whole decision detail.
- **Harder:** correcting an over-narrowed claim is a second write, not an edit.
  The claim exists at the narrow scope and is immutable in its identity columns
  (`veritymem.enforce_claim_transition()` forbids changing `scope_id`? — it does
  **not**: `scope_id` is absent from the immutability list, so the accepted scope
  is in fact mutable by a direct `UPDATE`. See the gap list in
  `docs/threat-model.md`.) The intended path is a new candidate from a broader
  event.
- **Harder:** because narrowing is preferred over rejection, a *deliberately*
  over-broad candidate produces an accepted claim rather than a review item. An
  extractor that always requests tenant-wide scope will fill the claim store with
  correctly-narrowed claims and never once trigger a review. That is the intended
  behaviour, but it means the review-burden metric does not measure "extractors
  asking for too much".
- **Harder:** tenants get more scopes. `veritymem.ensure_scope()` creates a scope
  row per distinct `(tenant, project, user, agent, session, purpose-set)` tuple and
  scopes are never garbage collected, so narrowing increases the row count in the
  one table that has no RLS.

## Alternatives rejected

**Reject a broader-scope candidate.** Rejected: it discards good evidence for a
bookkeeping reason. The proposition is fine; only the requested audience was
wrong. Rejecting trains operators to ignore `reject`.

**Accept at the requested scope and flag it with `verify`.** Rejected: this is
scope broadening with an annotation. The claim is in the store at the wider scope,
so it is a retrieval candidate for callers who should never see it, and the flag
is advisory to a model. It is the "filtering after vector search leaks through
counts" failure applied to authorization.

**Accept at the requested scope only if a human approves.** Rejected as the
default because it converts every scope mismatch into review burden, and
`AGENT-BRIEF.md` treats the 2% ceiling as a product-failure threshold. Review is
reserved for cases where narrowing cannot produce a usable claim.

**Silently rewrite the requested scope before the gate sees it.** Rejected:
narrowing must be a *decision with a reason code*, not a pipeline detail.
Otherwise `/explain` cannot answer "why is this claim narrower than the extractor
asked for".
