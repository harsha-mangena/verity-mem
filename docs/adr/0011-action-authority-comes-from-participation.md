# ADR 0011 — An action gate's authority comes from participation, not from a role

**Status:** Accepted, with a known onboarding cost.

## Context

`evaluateAction` answers one question before a consequential side effect: may this
principal act on this memory, right now? It answers it by re-planning the caller's reach
and re-reading the claims, so a revocation or an expiry between the query and the action
changes the answer.

Reach is computed from server-side state, not from the request:

```
reach(principal) = principal_scopes(principal) ∪ live grants(principal)
```

`principal_scopes` is written by `veritymem.record_participation` at the moment a
principal **writes** in a scope (migration 0008). The request's scope selector can only
narrow that set; it can never widen it.

The consequence, found while building the reference workload: a release manager who has
only ever written inside their own user scope (`project=payments, user=dana`) cannot
authorise an action citing a project-scope CI claim (`project=payments`, no user). The
gate refuses with `action.denied_unknown_claim`. It is not a permission error in the
usual sense — the principal has no relationship to that claim at all — but from the
operator's side it looks like one, and the fix is non-obvious: write something in the
project scope first.

## Decision

**Keep participation-based reach, and do not add a role-to-scope mapping in v0.1.**

The reference workload writes at project scope before expecting project-scope authority,
and the onboarding cost is documented here rather than worked around.

## Why not a role table

The obvious alternative is a `roles` table mapping principals to scopes, so an operator
can grant `release_manager` the `payments` project and have the gate honour it.

That is a real feature and it belongs in v0.3 alongside OpenFGA/OPA, which the
specification already defers. Building it now would mean two sources of reach — a role
table and `principal_scopes` — and two sources for an authorization decision is exactly
the condition that produced the cross-user isolation defect recorded in the threat
model's third addendum: `resolveScopes` and `scope_contains` disagreed about what a
selector meant, and the disagreement was invisible until a probe looked for it.

There is also a security argument, and it is the stronger one. Participation is
*evidence*: a principal wrote here, so the system has a record of the relationship
forming, with a timestamp and an actor. A role grant is an *assertion*: someone said so.
Both are legitimate, but they should not be conflated, and the v0.1 authorization model
is simpler to reason about when every edge in it corresponds to something that actually
happened.

## Consequences

- **An operator onboarding a new workload must write before it can act.** The failure is
  a refusal, not a silent success, which is the correct direction to fail — but it will
  be encountered as a surprise, and the error code (`action.denied_unknown_claim`) does
  not distinguish "you have no relationship to this claim" from "this claim does not
  exist". Making a caller unable to tell those apart is deliberate for *reads* (it would
  otherwise be an existence oracle) and arguably wrong for the action gate, where the
  caller is authenticated and about to take a side effect.
- **The `admin` source exists as a documented escape hatch.** `recordAdminParticipation`
  writes a membership labelled `admin`, so an operator can prime reach without
  fabricating an event. That is the supported path for the onboarding case, and it is
  auditable: the row records that it was an administrative act rather than organic
  participation.
- **Grants remain the mechanism for reaching what you do not participate in.** A grant is
  time-bounded, purpose-scoped and revocable, which is what a cross-principal
  authorization should be.

## What would change this decision

A deployment that needs role-based authority across many principals, or an operator for
whom "write an event first" is not an acceptable onboarding step. Either would justify
the v0.3 policy-engine work early — and would need the two sources reconciled into one
before the second is added, not after.
