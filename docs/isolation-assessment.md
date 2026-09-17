# Independent isolation assessment — scope, corpus and required environment

**Status: the corpus is executable and passing; the assessment has not been performed.**

This document exists because the specification is explicit that a self-graded isolation claim
is worthless: *"'Zero cross-tenant retrievals' means nothing against fixtures you wrote."*
It is right, and the boundary is this file's subject. The authors of a system can only test the
boundaries they thought of.

So this document is split honestly:

- **What is here:** an executable corpus (`packages/retrieval/src/isolation-corpus.test.ts`)
  covering one case per boundary the specification claims, each with a positive control. It
  passes. It is a regression net, not evidence of isolation in the sense the exit target means.
- **What is not here:** an assessment. It requires a team that did not write the system, an
  environment this one is not, and an attack plan broader than the boundary list below. The
  exit target stays **unmeasured**.

## Why a passing corpus is not the target

Two failure modes make a self-written isolation suite systematically over-optimistic:

1. **Enumerated boundaries.** The corpus tests tenant, project, user, agent, session and
   purpose, because those are the dimensions the schema has. A real assessment asks what happens
   when a boundary is expressible in the schema but not in the enumeration — a grant whose
   pattern matches more than its author intended, a scope whose purpose array was widened by a
   later write, a claim reachable through a relation rather than through its own scope.
2. **Testing for absence only.** A control that blocks *everything* passes every absence
   assertion. Every case in the shipped corpus therefore carries a positive control — the same
   principal reaching what it should — because otherwise "isolation holds" and "the principal
   can see nothing at all" render identically. That is a minimum, not a solution: a positive
   control proves the path works for one principal, not that it fails for the right reason.

## Required environment

The assessment needs a deployment this repository does not include:

| Requirement | Why |
| --- | --- |
| Credentials issued through the reference path | A test account with hand-granted scopes can pass for reasons production would not. Tokens must come from the same issuance as a real deployment's. |
| Realistic data volume | Count and timing inference is invisible on a tenant with nine claims. The assessment needs tenants with thousands of claims across many scopes, so a count difference is measurable and a timing difference is not lost in noise. |
| Latency instrumentation outside the application | Timing inference must be measured from a client, not from a log line the application chose to emit. |
| A red team that did not write the system | Non-negotiable. Every case in this repository was written by the same author as the code it tests. |
| A frozen corpus, published before the test | An attack plan written after seeing the results is a description, not a test. |

## Attack plan

Each class below names what is attacked, the signal that would indicate a failure, and whether
the shipped corpus covers it.

### 1. Direct scope reach — *covered*

Attempt to read a claim by declaring a scope the caller does not hold: a sibling user, a
sibling project, a sibling tenant, a different agent, a sibling session, an unrelated purpose.
Also the composite case: declaring one scope while citing a claim from another.

**Failure signal:** any claim returned, or any change in `candidates_considered`,
`candidates_after_authz` or `candidates_denied_by_authz`.

### 2. Grant manipulation — *partially covered*

The corpus covers an expired grant and a live grant for the same subject. The assessment must
additionally cover:

- a grant whose `resource_pattern` matches more than intended (a project pattern reaching a
  sibling project, a tenant pattern reaching a sibling tenant);
- a grant revoked mid-session, and one revoked between a query and an action;
- a grant with an empty or wildcard purpose;
- a grant to a subject string that collides with another principal's identifier;
- **action authority inherited from a read grant**: `evaluateAction` re-plans reach, so a read
  grant must not authorise a write-side effect.

**Failure signal:** reach that outlives its grant, or an action allowed on a read-only grant.

### 3. Count and timing inference — *one case covered, the rest not*

The corpus asserts that two equally-empty purposes produce the same candidate count and a
denied count of zero. The assessment must go further, because the specification names this
class specifically: *"Filtering after vector search leaks through counts, timing, and
generated summaries."*

- Compare a query known to have matches in an unreachable scope against one with no matches
  anywhere, at the **client** level: response size, status, latency distribution, and any field
  that varies with the number of rows considered.
- Repeat at realistic volume, because a count leak is invisible when both counts are zero.
- Compare against the same query issued by a principal that *can* reach the scope, to separate
  "unreachable" from "slow".
- Check error paths: a validation failure that differs between an existing and a non-existent
  identifier is an existence oracle even when every success path agrees.

**Failure signal:** any statistically distinguishable difference between reachable-elsewhere and
nowhere, in bytes, status, or latency.

### 4. Privileged tool surfaces — *covered at unit level, not end to end*

The MCP server never registers a privileged tool in an ordinary session, and re-authorises
every call server-side. The assessment must attempt both: invoke a privileged tool through an
ordinary session's transport, and present a capability token whose allowlist includes it while
its scope does not.

**Failure signal:** the tool executes; or the refusal differs between "your token cannot do
this" and "this tool does not exist" in a way that maps the deployment.

### 5. Every REST read surface — *the agent-audience by-id routes covered; admin routes not*

`apps/server/src/rest-isolation.test.ts` now covers the five agent-audience by-id reads
against a second real tenant: `GET /v1/events/{id}`, `GET /v1/claims/{id}`,
`GET /v1/claims/{id}/explain`, `GET /v1/candidates/{id}` and `GET /v1/query-traces/{trace_id}`,
plus `POST /v1/query` on both the own-tenant and foreign-tenant-body paths.

Two properties are asserted per route rather than one, because only asserting "did not return
the row" passes for a route that is broken for everybody:

- a foreign credential gets a non-200, and the refusal echoes neither the identifier nor the
  event content; and
- the status *and* the error code are identical for an identifier that exists in another
  tenant and one that exists nowhere, so the refusal is not an existence oracle. Both are
  404 on this build, which is the right answer.

Each case carries its positive control: the owner's own read must return 200, and the owner's
own query must return the seeded claim, or the foreign assertions prove nothing. A separate
case drops to a raw connection as the *application role* with no request context and asserts
that `events` and `claims` read as zero rows, then binds a real context through
`veritymem.set_request_context` and asserts the same connection sees its own rows. That
distinguishes "the handler refused" from "the database never showed it the row", and it is
the second that survives a handler forgetting to check.

The mechanism is worth naming, because it was not obvious and cost time: a bodyless `POST`
sent with `content-type: application/json` is rejected by Fastify with a 400 **before any
handler runs**, and that 400 is shaped like an authorisation refusal. It is not one, and a
test that read it as one would have reported a boundary it never crossed.

**Still not covered here:** the admin routes on the agent audience (`/v1/grants`,
`/v1/grants/{id}`, `/v1/forget`, `/v1/forget/{job_id}`, `/v1/replay`, `/v1/evaluations/runs`),
and the deletion/revocation surface in §6. Both belong to the external assessment; the
admin routes need the `admin` audience and their own cross-tenant attempt, and pretending
otherwise because the agent-audience half is green would be exactly the substitution this
document warns about.

**Failure signal:** any 200 with foreign data; and separately, any response whose *status*
distinguishes an existing-but-unreachable identifier from a nonexistent one.

### 6. Deletion and revocation as an isolation property — *not covered*

Erase one subject, then attempt to retrieve their claims through every surface above,
including relations and `/explain`. Then revoke a claim and attempt the same. Retention's
residual scan proves the live stores are clean; it does not prove the read path stops serving
what a racing query already cached.

**Failure signal:** a revoked or erased claim reachable through any path.

### 7. The action gate as the last boundary — *covered at unit level*

`evaluateAction` re-reads claims and re-verifies evidence digests, so it must refuse on state
that changed between the query and the action. The assessment should attempt a
time-of-check/time-of-use race: query, then revoke, then act.

**Failure signal:** an allowed action citing a claim that is revoked, unverifiable, or outside
the acting principal's reach at the moment of the action.

## What the corpus covers today

Nine cases, all passing, each with a positive control:

| Case | Boundary | Positive control |
| --- | --- | --- |
| B1.1 | tenant | own claim still reachable |
| B2.1 | project | own project still reachable |
| B3.1 | user | each user reaches its own |
| B3.2 | narrowing must not widen | own claim present |
| B4.1 | agent | agent reaches its own scope |
| B5.1 | session | session reaches its own scope |
| B6.1 | purpose | same purpose still reaches |
| B7.1 | count inference | two empty purposes agree |
| B8.1 | grant expiry | a live grant still confers reach |

Two findings from writing it, both recorded in the file because they are the kind of thing an
assessment would rediscover the hard way:

- **A principal that has never written anywhere holds no membership**, so it reaches nothing
  even in a scope that names it. Positive controls must establish membership first. This is
  ADR 0011 working as designed, and it means an assessment that creates fresh principals and
  expects them to read their own scope would report a false failure on every case.
- **The gate correctly refuses a duplicate of an accepted claim**, so cases sharing a statement
  fail for a reason unrelated to isolation. An isolation corpus needs mutually unique fixtures,
  or its failures are ambiguous between "the boundary leaked" and "the gate refused a
  duplicate" — and an ambiguous failure is not evidence either way.

## Reporting

The assessment's output should be a published report containing, per case: the surface
exercised, the principal and scope used, the exact request unless publishing it would itself
disclose a vulnerability, the observed response, and pass or fail. Plus the environment:
commit, deployment shape, credential issuance path, and data volume.

The exit target — **zero cross-tenant or revoked-grant retrievals** — is satisfied only by that
report. Until one exists, this document and its corpus are a regression net and an invitation.
