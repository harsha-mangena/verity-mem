# Security policy

VerityMem is a proof-carrying memory layer for AI agents: an append-only evidence
ledger, a policy commit gate, and disposable retrieval projections. This document
says how to report a vulnerability, what is in scope, which versions are supported,
and — with equal weight — **what the project does not yet claim**.

> **v0.1 is a pre-release.** There has been **no independent security review**. The
> default branch is under active construction. Do not deploy VerityMem in a
> multi-tenant production environment on the strength of this document.

---

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately to:

```
security@<project-domain-pending>
```

That address is a placeholder. The project does not yet have a domain, and this
document deliberately does not invent a working address, a PGP key, or a bug-bounty
programme. Until a real address exists, a report sent to the placeholder above will
not reach anyone. Where a repository host is available, prefer that host's private
vulnerability-reporting feature, which notifies the maintainers directly.

### What to include

A useful report is one a maintainer can reproduce without guessing:

1. **Affected component** — the package or file, and the version or commit.
2. **Impact** — what an attacker gains. "Cross-tenant read", "belief promoted
   without gate evaluation", "deletion reported verified while data survives".
3. **Reproduction** — the smallest sequence that demonstrates it. A SQL statement, a
   `CommitGate`/`compose` call, an HTTP request, or a failing test.
4. **Whether the database is required** — many of the interesting properties here
   live in row-level security policies and triggers, so a report that only exercises
   TypeScript may be reporting something the database already prevents, or missing
   something it does not.
5. **Your assessment of severity**, and whether you intend to disclose publicly.

Reports that state a *class* of problem — "authorization is enforced in two places
and they can disagree" — are as valuable as a working exploit. Two of the bugs this
project has already fixed were exactly that shape.

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of receipt | 3 business days |
| Initial triage and severity assessment | 10 business days |
| Fix or a documented mitigation plan for High and Critical | 30 days from triage |
| Fix for Medium and below | next release |
| Public disclosure | coordinated with you, after a fix or mitigation is available |

These are targets, not commitments. This is an unfunded pre-release project and
there is no on-call rotation. If a report is not acknowledged within ten business
days, assume the placeholder address is still in place and escalate through the
repository host.

### Safe harbour

Good-faith security research on VerityMem is welcome. Do not:

- access, modify or exfiltrate data belonging to anyone else;
- run testing against a deployment you do not own or have written permission to test;
- degrade service for other users, or run denial-of-service tests;
- use a finding for extortion, or publish an exploit before a fix is available and a
  disclosure date is agreed.

Reports that follow this document will not be pursued. The project will credit you in
the fix's release notes unless you ask otherwise.

---

## Supported versions

| Version | Supported | Notes |
| --- | --- | --- |
| `main` (v0.1 pre-release) | Security fixes only | The only branch. No stable release exists |
| Any tagged release | None yet | There are no tags |
| v0.5 and later | Not yet applicable | Deletion-across-backups and crypto-shredding hardening are scheduled there |

There is **no back-port policy**, because there is nothing to back-port to. Once
tagged releases exist, this table will name them and state which receive fixes.

The repository has no commits on `main` at the time of writing, so "version" means
the working tree you tested. Include the file checksums or a tree hash in your report
if you can.

---

## Scope

### In scope

The components that carry the correctness and isolation claims:

| Component | Path |
| --- | --- |
| Evidence ledger, hash chain, spans, idempotency, blobs, outbox | `packages/ledger/src/` |
| Commit gate, entailment backends, span validation | `packages/gate/src/` |
| Claim lifecycle, bi-temporal queries, use policy | `packages/claims/src/` |
| Query planner, retrieval channels, packet composition, projections, retention | `packages/retrieval/src/` |
| Extraction pipeline, deterministic extractors, model adapter interface | `packages/model-adapters/src/` |
| Schemas, closed vocabularies, reason codes, policy constants | `packages/contracts/src/` |
| SQL: enums, tables, constraints, triggers, RLS policies, the authorization predicate | `migrations/` |
| Reference deployment | `deploy/compose/` |

The findings most worth reporting, in rough order of severity:

1. **Scope or tenant escape.** Any read of a row whose scope is not contained by the
   caller's, or any write outside the caller's tenant. The invariants are
   `veritymem.row_authorized()` and `veritymem.scope_reachable()`; the enforcement
   points are the RLS policies in `migrations/0006_scope_reach_predicate.sql` and the
   planner's `authorize-before-retrieve` ordering.
2. **Promotion without the gate.** Any path that writes `claims.status = 'accepted'`
   other than `CommitGate.insertClaim()`, or any way to make the gate return `accept`
   for a candidate whose spans do not resolve or whose entailment is not `entailed`.
3. **Evidence not actually verified.** A span whose bytes do not match its
   `span_digest` being returned as `digest_ok: true`, on any read path.
4. **Ledger mutation.** A way to change `events.payload`, `content_hash`, `prev_hash`,
   `link_hash`, `seq`, or to delete an event, that does not go through the permitted
   retention redaction shape.
5. **Deletion reported as verified when it is not.** `forget()` must report
   `residual_matches > 0` whenever any declared store still holds a copy of the
   subject. **Known issue:** it currently reports `verified` vacuously — see below.
6. **Prompt-injection escape.** Any path by which stored content reaches a system
   message, or by which content escapes the `fenceContent()` region.
7. **Capability confusion.** A caller reaching privileged behaviour without an
   appropriate privilege, or a claim's authority class becoming stronger than its
   origin warrants.
8. **Retention or grant logic that under-deletes or over-grants** in
   `packages/retrieval/src/retention.ts` and `resolveScopes()` in the planner.

### Out of scope

- **The absence of features that are documented as absent.** Most of the service
  layer does not exist yet (`apps/server`, `apps/mcp-server`, `packages/sdk-ts`,
  `packages/langgraph-js`, the action gate, `/v1/replay`, `/v1/forget`,
  `/v1/claims/{id}/explain`). "There is no authentication middleware" is a true
  statement about a server that has not been written, not a vulnerability. It is
  listed in `docs/threat-model.md` §6.2.
- **Configuration that is inert.** Several environment variables are parsed and
  never consumed. That is a bug, and it is documented in `docs/threat-model.md`
  §6.4; it is not a security finding unless an operator was relying on it as a
  control.
- **`apps/server`, `apps/worker`, `apps/reference-dev-agent`** as running programs —
  they contain only `package.json` files.
- **Upstream dependencies.** Report PostgreSQL, pgvector and Node findings upstream.
  A *misconfiguration* of them by this project is in scope.
- **Physical access, a compromised host, or a malicious database administrator.**
  The threat model treats an operator with database credentials as the trust root.
  See "What this project does not claim" below.
- **Social engineering, phishing, or physical attacks** against maintainers.
- **Findings that require a modified database schema** — for example, dropping a
  policy or disabling a trigger. An operator with the owner credential can do that;
  it is documented, not defended.
- **Denial of service by resource exhaustion** in a single-process library with no
  service layer.
- **Reports generated solely by a scanner** with no demonstrated impact.

---

## Known issues at the time of writing

These are stated here so that a reporter does not spend time rediscovering them, and
so that an operator does not deploy on an assumption the code does not support. Each
is described in full, with evidence, in `docs/threat-model.md`.

| # | Issue | Impact | Documented |
| --- | --- | --- | --- |
| 1 | `forget()` binds an empty scope and purpose set, so its scrub and its residual scan both observe zero rows and the job reports `verified` | **A deletion that erased nothing reports success.** Retention must not be relied on | `docs/threat-model.md` §6.1.2 |
| 2 | `OutboxWorker` binds an empty scope and purpose set, so the `project.claim` processor cannot read the claim it projects and silently no-ops | Dense and entity projections are never populated by the worker path | `docs/threat-model.md` §6.1.1 |
| 3 | An application-role connection can `INSERT` a claim with `status = 'accepted'` directly | "Only the gate promotes" is a property of the extractor interface, not a database privilege | `docs/data-model.md` §9 |
| 4 | `claims.scope_id`, `object`, `authority`, `valid_from`, `valid_to` and `expires_at` are mutable by `UPDATE` with no decision row | A claim's proposition, scope, authority and valid time can be rewritten after promotion. `search_tsv` follows an `object` rewrite, so the rewritten claim is still findable | `docs/data-model.md` §9 |
| 5 | `scopes`, `outbox`, `entity_aliases`, `projection_versions`, `principals`, `streams` and `tenants` have no row-level security | Any connection holding the application credential reads every tenant's scope metadata, alias strings and pending outbox payloads | `docs/threat-model.md` §2/A4 |
| 6 | `origin` and `actor_id` are caller-supplied and unverified; authority class is derived from `origin` | A caller can self-declare `origin: "database"` and receive `verified_record` authority, and can attribute claims to another subject key | `docs/threat-model.md` §1.4 |
| 7 | `events.sensitivity` is free text with no CHECK constraint | A typo silently disables the high-sensitivity quarantine branch | `docs/threat-model.md` §3/T12 |
| 8 | The gate quarantines only `procedure` and `permission`; the reason-code help text claims identity, money and safety are quarantined too | An identity, monetary or safety claim can auto-accept under a strong authority class | `docs/threat-model.md` §3/T11, `docs/policy-cookbook.md` §4 |
| 9 | Nothing calls `deindexClaim()` when a claim is revoked | A revoked claim keeps its dense vector until something re-projects it | `docs/threat-model.md` §3/T26 |
| 10 | The hash chain has no external anchor or signature | Tamper-evident against accident, **not** tamper-proof against an operator with database access | `docs/threat-model.md` §5.2 |
| 11 | ~~Blob bytes are never reclaimed~~ **Fixed.** `BlobStore` has `delete` and `sweep`, reclamation is reference-counted, and the residual scan reads the physical store | A shared object is retained until its last reference is gone; backups and replicas remain outside the manifest's scope, so "verified" means the live stores this deployment declares | `docs/threat-model.md` Addendum 6 |
| 12 | `migrations/0007_scope_contains.sql` is in the tree and **not applied**; it narrows the containment relation and introduces a second containment rule alongside the one the live policies use | Applying it changes who can read what. While it is pending, the policies and `veritymem.scope_contains()` disagree on whether a caller bound to a value reaches a row that leaves that dimension unbound | `docs/data-model.md` §5.2 |

**No isolation claim is currently made about this codebase**, and none should be.
The v0.1 exit target requires `0` cross-tenant retrievals *measured by an external
red team*; no external red team has been engaged. The in-house suite is 60 tests, of
which 51 pass and 9 fail as this is written. Two authorization bugs have already been
found and fixed
by that suite — see `docs/adr/0005-one-authorization-predicate.md` and
`docs/adr/0010-purpose-is-a-hard-boundary.md` — which is evidence that the suite has
value and also evidence that authorization bugs reach it.

---

## What this project does not claim

Read this as the boundary of the security policy. A report that hinges on one of
these is a documentation discussion, not a vulnerability.

### 1. There has been no independent security review

No external audit, no penetration test, no red team, no fuzzing campaign, no
supply-chain attestation, no SBOM, and no signed releases. `docs/threat-model.md` is
the project's own analysis by its own authors; treat it as a starting point for a
review, not the output of one.

**A self-graded security claim is worthless.** The project states this about itself
and means it.

### 2. No deletion across backups until v0.5

v0.1 is scoped to live stores. Deletion across backups requires envelope encryption
and is deferred to v0.5. A record erased from the live database may survive in:

- a base backup or a WAL archive;
- a filesystem snapshot;
- a replica;
- the blob store (see known issue 11);
- any copy an operator has taken.

**Additionally, live-store deletion does not currently work** (known issue 1). Until
that is fixed, treat every claim of forgetting as unproven.

### 3. Crypto-shredding is not implemented and is not a v0.1 promise

Per-subject envelope encryption, where destroying a key renders the ciphertext
meaningless, is a v0.5 hardening feature. There is no envelope encryption in this
codebase, no key hierarchy, and no key-destruction path. Encryption at rest, if any,
is whatever the operator's storage layer provides.

### 4. Entailment is a filter, not a guarantee

The commit gate reduces hallucinated writes; it does not eliminate them. Two failure
classes are documented rather than left to be discovered:

- **cross-sentence coreference** — the claim's referent sits outside the span, so the
  span alone does not establish it;
- **entity-attribution error** — the claim is genuinely entailed by a span about a
  *different entity*.

Both have reason codes (`entailment.known_coreference_failure`,
`entailment.known_entity_attribution_failure`) and neither is detected by the default
backend, which is a deterministic lexical overlap check that the code itself calls a
*stand-in*, not a verification. The opt-in ONNX backend exists but feeds a
placeholder tokenizer and is documented as not fit for scoring. **No measured
false-negative or false-positive rates have been published** for either backend.

Market this system as **traceable and bounded**, never as verified.

### 5. The hash chain is not tamper-proof

See known issue 10. It detects partial writes, accidental updates, reorderings,
in-place substitutions and splices between streams. It does not detect an operator who
recomputes the chain along an affected stream, because there is no secret and no
external witness. It buys effort and the detectability of carelessness.

### 6. Authorization is a containment boundary

Row-level security here enforces tenant, project and purpose containment. It
deliberately does not enforce per-user isolation on its own: a project-scoped caller
reaches every user in that project, which is intended and tested. Per-user isolation
depends on the query planner binding the caller at user level.

The predicate validates each row against the caller's **bound** scope set. It does
not derive the caller's entitlements — that is `resolveScopes()`'s judgement, and an
over-broad grant resolution authorizes too much without the database being able to
detect it.

### 7. Retrieved memory is not protected at the point of use

The read path returns structured JSON and there is no prompt composer, so nothing
currently concatenates stored text into a system message. That is a property of the
*absence* of a synthesis feature, not of a control. The action gate — the only real
enforcement point for a `verify` or `deny` verdict — is not implemented, so **a use
decision in a packet is advisory today**. The specification says this plainly: *"If
the action gate is not wired, the use decision is decoration."*

### 8. No telemetry, and no audit export

There is no telemetry code and telemetry is off by design. There is also no audit-log
export, no SIEM integration, and no tamper-evident log sink. `decisions` and
`query_traces` are ordinary tables; an operator with the owner credential can edit
them.

### 9. No compliance certification

No SOC 2, ISO 27001, HIPAA or GDPR certification, attestation, or mapping. Nothing
here should be given to a regulator as evidence of a control. If you need a DPIA, the
data model in `docs/data-model.md` is the input, and it is honest about which
retention paths do not work.

---

## Operator checklist before any deployment

Because the honest summary of the current tree is "a well-tested library with several
known gaps", the minimum bar for a real deployment is:

1. **Do not expose the append path to a caller that can choose `origin` freely.**
   Constrain `origin` in your own authentication layer, or every caller can grant
   itself `verified_record` authority (known issue 6).
2. **Do not use `forget()`.** It reports success without erasing (known issue 1).
   Redact manually if you must, and verify the redaction yourself.
3. **Do not run the outbox worker and expect projections.** The `project.claim`
   processor no-ops (known issue 2). Populate projections with
   `rebuildProjections()` under a correctly bound context, or fix the worker
   binding.
4. **Use a distinct, least-privilege database role for the application** and do not
   grant it table ownership. The default `veritymem_app` role is already
   `NOSUPERUSER NOBYPASSRLS`; keep it that way.
5. **Do not place two tenants' data behind one application credential and consider
   the isolation proven.** Seven tables have no RLS (known issue 5) and the
   per-user boundary belongs to the planner.
6. **Point `events.sensitivity` at a controlled vocabulary at your ingress**, not at
   user input (known issue 7).
7. **Treat `admission.external_instruction` in `decisions.reason_codes` as a security
   event**, not a routine code.
8. **Do not render packet contents into a system prompt.** If you add synthesis,
   place retrieved claims in a delimited user region and state that the region is
   data. Prefer the structured packet.
9. **Take your own backups, and do not tell anyone deletion is proven.**
10. **Re-read `docs/threat-model.md` §6 against the tree you are deploying.** The
    repository is under active construction and several items in this document have
    changed status during its own writing.

---

## Related documents

| Document | Contents |
| --- | --- |
| `docs/threat-model.md` | Assets, trust zones, adversaries, the threat table with per-threat enforcement points, the prompt-injection surface, and the full known-limitations list |
| `docs/data-model.md` | The schema as implemented, the four object lifecycles, append-only enforcement, bi-temporal columns, retention semantics, and schema-level gaps |
| `docs/policy-cookbook.md` | How to change gate behaviour, which knobs are actually wired, reason-code reference, and how to replay an old ledger under an old policy |
| `docs/adr/` | Architecture decision records, including the two authorization bugs found and fixed |
| `AGENT-BRIEF.md` | Repository conventions and the non-negotiables |
