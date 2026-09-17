# ADR 0009 — Apache-2.0 licence, and every correctness feature stays out of any paid tier

**Status:** Accepted · v0.1

## Context

VerityMem is a library that is meant to be embedded inside other people's agent
applications, next to their data and their authorization model. Two licensing
questions follow, and they are separable:

1. **Which licence?** Every system VerityMem must interoperate with — Mem0,
   Graphiti, Cognee, Letta — is Apache-2.0. A memory layer that an application
   cannot link without legal review does not get adopted.
2. **What is the commercial boundary, if one ever exists?** The specification
   identifies a specific pattern to criticise: an open core whose correctness
   features are held back so the hosted tier is the only trustworthy option.

`AGENT-BRIEF.md` and the root `package.json` both record `Apache-2.0`.

## Decision

### Licence

**Apache-2.0**, declared in `package.json` (`"license": "Apache-2.0"`) and carried
into every workspace package.

Rejected alternatives and why:

- **AGPL-3.0** blocks exactly the embedding that adoption requires. A memory layer
  embedded in a SaaS agent would trigger the network-copyleft clause, which is a
  conversation no adopter wants to have before the project has users.
- **Source-available / BSL** buys commercial defence against strip-mining by a
  hyperscaler. At v0.1 the binding constraint is adoption, not strip-mining, and a
  source-available licence removes the one thing an early project needs.
- **MIT** is compatible and would be fine, but it drops the explicit patent grant.
  For a system that will be implemented against by third parties, the patent grant
  is worth the extra length.

### The commercial boundary

**The entire trust-critical core stays open and no correctness feature ever moves
behind a paid tier.** Concretely, this covers:

| Component | Where |
| --- | --- |
| Ledger, hash chain, idempotency, spans, blobs, outbox | `packages/ledger` |
| Commit gate, entailment backends, span validation | `packages/gate` |
| Claim lifecycle, bi-temporal queries, use policy | `packages/claims` |
| Policy documents, thresholds, reason codes | `packages/contracts`, `packages/policy` |
| RLS predicate, append-only triggers, lifecycle triggers | `migrations/` |
| Conformance and poisoning fixtures | `fixtures/` |
| Replay oracle and LedgerBench | `scripts/`, `python/evals/` |

If a hosted tier ever exists, it monetises **operations, compliance packaging and
support** — managed upgrades, retention jobs at scale, audit export, an SLA — not
the gate, not retrieval, not deletion.

The reason is not sentiment. A memory layer's value proposition is that its
correctness claims are checkable by the party relying on them. If the check
requires a subscription, the claim is marketing, and the project has become the
thing it was written to criticise.

## Consequences

- Downstream embedding is frictionless: no copyleft trigger, no commercial
  negotiation, an explicit patent grant.
- The correctness argument is auditable by anyone, including an adversary, which
  is a precondition for the external red team the v0.1 exit target requires. A
  red team cannot audit a binary.
- Governance follows the same logic: DCO sign-off rather than a CLA, published
  ADRs, published roadmap, published benchmarks. A CLA is a prerequisite for
  relicensing, and relicensing is how open cores close.
- **Harder:** there is no revenue mechanism in v0.1 and no plausible one that does
  not require operational maturity the project does not have. This is a bet on
  adoption, and the specification's own demand test says so explicitly.
- **Harder:** a contributor who wants to build a paid product on top can do so and
  owes nothing. That is the intended cost of the licence, and it must not be
  walked back later — a licence change after adoption is the exact behaviour this
  ADR exists to preclude.
- **Harder:** there is no leverage to compel a hyperscaler to contribute. The
  mitigation is the one the specification names: keep the core correct and the
  conformance suite authoritative, so a fork that diverges is visibly non-conformant.

## Alternatives rejected

**Open core with the commit gate held back.** Rejected. The gate *is* the product;
withholding it leaves an ADD-only memory store with extra steps, which is the
market the project claims is already occupied.

**Open core with "advanced" entailment (the ONNX backend) held back.** Rejected,
and it is the most tempting version of the mistake. It would make the *honest*
configuration (`lexical`, which says it is a stand-in) the free one and the
*accurate* configuration the paid one — so the free tier's correctness claims
would be permanently weaker, and the review-burden numbers would differ by tier.
Both backends are in `packages/gate/src/entailment.ts` and both are open.

**AGPL with a commercial dual-licence.** Rejected: it makes the free tier
unusable for the primary use case and the paid tier the only real option, which is
a paid tier by another name.

**No licence file at all until v1.0.** Rejected: "no licence" is "all rights
reserved" by default, which is the most restrictive option available and the
opposite of the intent.
