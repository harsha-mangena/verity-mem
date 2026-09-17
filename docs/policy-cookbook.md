# Policy cookbook — how to change gate behaviour safely

For an operator who needs to move a threshold, add a quarantine rule, or explain why
the gate did what it did. Every constant named here is a real exported symbol; every
procedure is one you can run.

> **Read this before changing anything.** Almost every number in this document is
> currently **inert**. §1 lists exactly which knobs are wired and which are not. An
> operator who tunes an unwired constant will believe the system changed and will
> have changed nothing.

---

## 1. What is actually wired

| Knob | Symbol | Read by | Live? |
| --- | --- | --- | --- |
| Auto-accept entailment floor | `DEFAULT_COMMIT_POLICY.thresholds.entailmentFloor` = `0.5` | `CommitGate.evaluate()` — `verdict.score < this.policy.thresholds.entailmentFloor` | **Yes**, when a `CommitPolicy` is passed to the gate |
| Quarantine kinds | `DEFAULT_COMMIT_POLICY.quarantineKinds` = `QUARANTINE_KINDS` = `["procedure","permission"]` | `CommitGate.evaluate()` — `kindQuarantined` | **Yes** |
| Auto-accept authorities | `DEFAULT_COMMIT_POLICY.autoAcceptAuthorities` | `CommitGate.evaluate()` — `authorityStrong` | **Yes** |
| Staleness horizons | `DEFAULT_COMMIT_POLICY.stalenessHorizonDays` = `STALENESS_HORIZON_DAYS` | `stalenessHorizonFor(kind)` → `evaluateUse()` | **Yes** |
| Review-burden ceiling | `GATE_THRESHOLDS.reviewBurdenCeiling` = `0.02` | Nothing | **No** — a documented target, not an enforced limit |
| Lexical overlap floor | `GATE_THRESHOLDS.lexicalEntailmentFloor` = `0.6` | `pipeline.test.ts` constructs `new LexicalEntailmentBackend({ floor: … })` from it. `LexicalEntailmentBackend`'s own default is also `0.6` | **In tests only** — no production path constructs the backend |
| Policy version string | `DEFAULT_COMMIT_POLICY.version` = `"commit-v3"` | Written to `decisions.policy_version` and returned in `GateResult.policy_version` | **Yes** |
| Use policy version | `DEFAULT_USE_POLICY_VERSION` = `"use-v2"` | `planQuery()` default → `MemoryPacket.policy_version` | **Yes** |
| Action policy version | `DEFAULT_ACTION_POLICY_VERSION` = `"action-v1"` | Nothing — the action gate is not implemented | **No** |
| Risk→allowed-use map | `RISK_TO_ALLOWED_USE` | Nothing — the action gate is not implemented | **No** |
| Risk→max evidence age | `RISK_TO_MAX_EVIDENCE_AGE_DAYS` | Nothing — the action gate is not implemented | **No** |
| `GATE_ENTAILMENT_BACKEND` | `Env.gate.backend` | Nothing | **No** |
| `GATE_CONFIDENCE_THRESHOLD` | `Env.gate.confidenceThreshold` | Nothing | **No** |
| `RETENTION_LEDGER_MODE` | `Env.retention.ledgerMode` | Nothing — `forget()` takes the mode from the request | **No** |

The practical consequence: **today, the only way to change gate behaviour is to edit
`packages/contracts/src/policy.ts` and construct the gate with your modified
`CommitPolicy`.** There is no configuration file, no environment variable, and no
server to reload one. `CommitGate`'s constructor takes
`policy?: CommitPolicy`, so passing a modified object is supported — but the object
is a TypeScript value, not a document loaded at runtime.

If you need runtime policy, the smallest correct change is to load a
`CommitPolicy` JSON document at worker start, validate it against the
`CommitPolicy` interface, and pass it in. Do **not** add per-request policy
overrides: the policy version recorded on a decision must be the policy that
actually ran.

---

## 2. The policy version string

### What it means

`CommitPolicy.version` appears verbatim in three places:

1. `decisions.policy_version` — on every promotion, rejection, quarantine and review
   record.
2. `GateResult.policy_version` — returned from `CommitGate.evaluate()`.
3. `query_traces.policy_version` — the *use* policy version in force when a query ran
   (`plan.policy_version`, from `DEFAULT_USE_POLICY_VERSION`).

There are three independent version strings because there are three independent
decision surfaces, and conflating them would make a read-policy change look like a
write-policy change:

| Version | Governs | Constant |
| --- | --- | --- |
| `commit-v3` | Whether a candidate becomes an accepted claim | `DEFAULT_COMMIT_POLICY.version` |
| `use-v2` | Whether a returned claim is `use` / `verify` / `clarify` / `deny` | `DEFAULT_USE_POLICY_VERSION` |
| `action-v1` | Whether a side effect may proceed (unimplemented) | `DEFAULT_ACTION_POLICY_VERSION` |

### Bumping it is a recorded event, not a deploy detail

The policy module's doc comment states the contract:

> *"A policy change is therefore a recorded event, not a silent behavioural shift:
> `/v1/replay` can re-evaluate an old ledger under the old policy and get the old
> answer back, which is the only way 'why did the system believe this in March?' has
> a real answer."*

The mechanism is that `decision.policy_version` is written **at decision time**, so
an old decision carries the version that produced it, permanently. Nothing rewrites
it. A query for "every decision made under `commit-v3`" is:

```sql
SELECT outcome, count(*)
  FROM decisions
 WHERE policy_version = 'commit-v3'
 GROUP BY outcome ORDER BY 2 DESC;
```

**Bumping the version is a bug if it is not accompanied by a behavioural change, and
a bug if a behavioural change is not accompanied by a bump.** `packages/contracts/src/policy.ts`
says so: *"bumping it without recording the reason is a bug."* The discipline:

| Change | Required |
| --- | --- |
| Any edit to `quarantineKinds`, `autoAcceptAuthorities`, `stalenessHorizonDays`, or any value in `thresholds` | Bump `version`. It is behaviour, and every affected decision must be attributable |
| Adding or removing a `REASON_CODES` member | Do **not** bump the policy version (it is a vocabulary change, not a behaviour change) — but `packages/contracts/src/vocabulary.test.ts` enforces the code shape, and `/explain` groups by namespace, so keep the `stage.detail` form |
| A code change that alters the decision cascade in `CommitGate.evaluate()` | Bump `version`. The version identifies the *policy*, and the cascade is the policy |
| Adding a new `ClaimKind` or enum member | A migration plus a TypeScript tuple edit; the drift test fails until both are done |

### What bumping does *not* do

It does not re-evaluate anything. Existing decisions keep their old version and stay
valid. There is no "migrate decisions to the new policy" operation and there must not
be — a decision is a historical fact. Re-evaluation is `/v1/replay`'s job (§7), and
it produces new decisions rather than editing old ones.

---

## 3. Reading reason codes

Reason codes are the gate's only machine-readable explanation, and they are a
**closed set**. `REASON_CODES` in `packages/contracts/src/reason-codes.ts` is the
registry; `REASON_CODE_VALUES` is the frozen list; `isKnownReasonCode(code)` tests
membership; `REASON_CODE_HELP` maps each code to a sentence for `/explain`.

### The namespaces, and what each one tells you

| Prefix | Meaning | Who emits it |
| --- | --- | --- |
| `span.*` | Span resolution and digest integrity | `CommitGate.verifyEvidence()`, `validateSpans()` |
| `evidence.*` | Whether any supporting evidence exists at all | `CommitGate.evaluate()` |
| `entailment.*` | The entailment verdict and the known failure classes | `CommitGate.evaluate()` |
| `authority.*` | The authority class and whether it can auto-accept | `CommitGate.evaluate()` |
| `scope.*` | Requested scope versus evidence scope | `CommitGate.evaluate()` |
| `conflict.*` | Accepted claims bearing on this proposition | `CommitGate.findConflicts()` |
| `admission.*` | Pre-extraction classification: instruction-like, external, sensitive | `admit()` |
| `kind.*` | The claim kind is privileged or needs review | `CommitGate.evaluate()` |
| `extractor.*` | Whether a model was involved | `CommitGate.evaluate()` |
| `gate.*` | The outcome itself | `CommitGate.evaluate()` |
| `use.*` | The read-side use decision | `evaluateUse()` |
| `action.*` | The action gate (unimplemented) | — |
| `retention.*` | Forgetting manifest and residual scan | `retention.forget()` |

### The codes that mean the gate is working

These are normal and should not be alerted on:

| Code | Means |
| --- | --- |
| `span.resolved` | Every supporting span resolved and its digest matched |
| `entailment.entailed` | The proposition is entailed under the configured model |
| `authority.strong` | Origin class is `verified_record`, `observation` or `user_self_report` |
| `scope.within_event_scope` | Requested scope is contained by the evidence scope |
| `conflict.none` | No accepted claim in scope bears on this proposition |
| `gate.auto_accept_eligible` | Every auto-accept precondition held |
| `extractor.deterministic` | No model call was involved |

### The codes that mean something needs attention

| Code | What to do |
| --- | --- |
| `entailment.unavailable` | The entailment backend failed or was never constructed. Every candidate is now `needs_review`. This is a **fail-closed outage**, not a degradation — investigate immediately |
| `entailment.below_threshold` | The backend said `entailed` but scored under `entailmentFloor`. The candidate is `needs_review`. Either the floor is too high or the backend is too weak for this content |
| `span.digest_mismatch` | **The bytes at the recorded offsets no longer hash to the recorded digest.** The payload changed under a live span. Treat as an integrity incident: find the writer |
| `span.out_of_bounds` | The span extends past the current payload. Same class as above |
| `span.event_redacted` | The payload was erased under retention. Expected after a forget; the claim is now unusable, which is correct |
| `admission.instruction_like` | The payload contains instruction-like material. An operator signal even when the gate handles it correctly |
| `admission.external_instruction` | Instruction-like content arrived from an external origin. **This is an injection attempt.** Alert on it |
| `conflict.contradicts_accepted` | The candidate opposes an accepted claim. Blocked from auto-accept; the relation is recorded |
| `kind.requires_review` | The kind is privileged. Note that it currently fires only for `procedure` and `permission` (§4) |
| `use.revoked` | The claim was revoked and must not be used. If this appears on a *returned* claim, something is indexing revoked claims |

### Queries

```sql
-- The full reason-code trace of one decision, with human-readable help beside it
SELECT d.outcome, d.policy_version, d.decided_at,
       rc AS reason_code,
       (SELECT count(*) FROM decisions d2
         WHERE d2.decision_id = d.decision_id) AS _same
  FROM decisions d, unnest(d.reason_codes) AS rc
 WHERE d.decision_id = $1;

-- Frequency by code and outcome over a window
SELECT rc AS reason_code, d.outcome, count(*) AS n
  FROM decisions d, unnest(d.reason_codes) AS rc
 WHERE d.decided_at >= now() - interval '7 days'
 GROUP BY rc, d.outcome
 ORDER BY n DESC;

-- Every decision where the payload under a span drifted. Integrity incidents.
SELECT decided_at, candidate_id, claim_id, reason_codes
  FROM decisions
 WHERE reason_codes && ARRAY['span.digest_mismatch','span.out_of_bounds']
 ORDER BY decided_at DESC;

-- Every external instruction attempt
SELECT decided_at, candidate_id, outcome,
       detail->'instruction_matches' AS matches
  FROM decisions
 WHERE 'admission.external_instruction' = ANY(reason_codes)
 ORDER BY decided_at DESC;
```

`REASON_CODE_HELP` is the operator-facing text for each code and exists so that
nobody has to read the source to interpret a decision. It is consumed by
`ClaimExplanationSchema.reason_help` — an endpoint that is specified and not yet
implemented, so today you read the map directly:

```ts
import { REASON_CODE_HELP, REASON_CODES } from "@veritymem/contracts";
console.log(REASON_CODE_HELP[REASON_CODES.ENTAILMENT_BELOW_THRESHOLD]);
```

### Two things reason codes do not do

- **They are not validated on write.** `isKnownReasonCode()` is called by the
  LedgerBench parser and the vocabulary test, but **not** by `CommitGate.insertDecision()`.
  An ad-hoc code inserted by any other writer would be stored and would break
  `/explain`'s help lookup. If you add a writer, call `isKnownReasonCode()`.
- **They are not ordered.** A decision carries every code that fired, in cascade
  order, and two codes can describe the same condition
  (`span.digest_mismatch` and `span.unresolvable` always appear together). Read the
  `gate.*` code for the outcome and the rest for the story.

---

## 4. Quarantine kinds, and why those five

### What the specification requires

> *"Quarantines identity, permission, money, safety, and executable-procedure
> claims."*

The rationale is that these are the kinds where **a wrong belief grants capability or
changes behaviour**, rather than merely being wrong. A wrong preference wastes a
minute. A wrong permission grants access. A wrong procedure executes.

### What the code does

```ts
export const QUARANTINE_KINDS = ["procedure", "permission"] as const;
```

`claim_kind` is:

```
'observation','user_self_report','preference','event','decision',
'plan','hypothesis','procedure','permission','derived_summary'
```

There is **no `identity`, `money` or `safety` member**. `CommitGate.evaluate()`'s
quarantine test is a membership check against `quarantineKinds`, so it can only ever
fire for a kind that exists.

**So the gate quarantines executable procedures and permissions, and nothing else by
kind.** The reason-code help string for `kind.requires_review` still reads *"The claim
kind is identity, permission, money, safety or executable procedure, which requires a
human"* — that sentence is aspirational and currently inaccurate. It is a
documentation bug with security consequences, because an operator reading it would
believe identity and money claims are handled.

### Where identity, money and safety claims actually go

They are not unhandled; they are handled by *other* rules, which is weaker:

| Concern | What catches it | Why that is weaker |
| --- | --- | --- |
| Identity | Nothing by kind. `user_self_report` is in `AUTO_ACCEPT_AUTHORITIES`, so `"I am the CFO of Acme"` can auto-accept if it is entailed by the span | No second check. The claim store's subject keys are built from a caller-supplied `actor_id`, so attribution is caller-controlled |
| Money | Nothing by kind. A `decision` or `event` whose `object` is an amount is gated like any other | The gate never inspects `object`. `"I approved the $2M transfer"` is a `decision` and can auto-accept |
| Safety | Partially, via `procedure`. A safety *constraint* stated as prose is an `observation` or a `preference` and auto-accepts | No `object` inspection, no classifier |

### If you want the specification's behaviour

You have to choose, and the choice has a review-burden cost:

**Option A — add the kinds.** Add `identity`, `money`, `safety` to `claim_kind` (a
migration, plus `CLAIM_KINDS` in `packages/contracts/src/primitives.ts` — the drift
test fails until both are updated), add them to `QUARANTINE_KINDS`, and instruct your
extractors to emit them. This is the correct fix and it makes the reason-code text
true.

**Option B — quarantine by predicate, not by kind.** Extend the gate with a check on
`candidate.object` and `candidate.predicate` for monetary and identity shapes. This
avoids a schema change but puts a classifier in the gate, which is the kind of
heuristic that ages badly and cannot be explained in one sentence to an operator.

**Option C — narrow what the system accepts.** `AGENT-BRIEF.md` and the
specification both name this as the legitimate alternative to a high review burden:
*"Tune the policy until that holds, or narrow the claim kinds the system accepts."*
If identity, money and safety claims cannot be gated well, stop extracting them. Do
not leave them accepted-and-unmarked.

**Until one of those is done, do not describe the system as quarantining identity,
money or safety claims.** Say: *it quarantines executable procedures and
permissions.*

### The other two quarantine triggers

Beyond kind, `CommitGate.evaluate()` quarantines on:

- **`sensitivity == 'high'`** (`admission.sensitive`). `events.sensitivity` is free
  `TEXT NOT NULL DEFAULT 'normal'` with **no CHECK and no enum**. `'High'`, `'high '`
  and `'secret'` are all stored verbatim and quarantine nothing. Normalise at your
  ingress, or add a CHECK constraint in a migration.
- **Instruction-like content from an external origin** (`admission.external_instruction`).
  `isExternalOrigin()` is `origin === "document" || origin === "database"`, and
  `origin` is caller-supplied.

```sql
-- How often each quarantine trigger fires, and for what
SELECT
  count(*) FILTER (WHERE 'kind.privileged' = ANY(reason_codes))            AS by_kind,
  count(*) FILTER (WHERE 'admission.sensitive' = ANY(reason_codes))        AS by_sensitivity,
  count(*) FILTER (WHERE 'admission.external_instruction' = ANY(reason_codes)) AS by_injection
  FROM decisions
 WHERE outcome = 'quarantine'
   AND decided_at >= now() - interval '30 days';
```

---

## 5. The review-burden ceiling is a product-failure metric

### The number

```ts
/** Fraction of writes permitted to require human review before the gate is called miscalibrated. */
readonly reviewBurdenCeiling: number;   // 0.02 in GATE_THRESHOLDS
```

### What it means

The specification's framing, which the constant encodes:

> *"`needs_review` and `quarantine` require a human. In a CI agent at 03:00 there is
> no human. Review burden is therefore a **product-failure metric, not an ops
> metric**: if more than 2% of writes on the reference workload require human review,
> the gate is miscalibrated and the product is unusable regardless of its correctness
> scores."*

Read that twice, because it is the opposite of how review queues are usually
reasoned about. A review queue is not a safety feature; it is a **latency and
availability failure** for any workload without a human in the loop. An agent that
writes a claim and must wait for review is an agent that does not write.

So the ceiling is an **exit criterion**, not an alert threshold. It appears in the
specification's v0.1 exit targets and again in the kill criteria:

| Where | Condition | Response |
| --- | --- | --- |
| v0.1 exit targets | *"Review burden under 2% of writes on the reference workload"* | Must hold to ship |
| Kill criteria | *"Review burden stays above 2%"* at three months | *"Narrow accepted claim kinds, or abandon the human-review branch entirely"* |

### It is not enforced anywhere

`reviewBurdenCeiling` is a declared constant with no reader. Nothing computes the
ratio, nothing refuses a write, nothing alerts. Computing it is your job:

```sql
-- Review burden per tenant per day, with the ceiling applied
SELECT tenant_id,
       date_trunc('day', decided_at) AS day,
       count(*) FILTER (WHERE outcome IN ('needs_review','quarantine')) AS review,
       count(*) AS decisions,
       round(
         (count(*) FILTER (WHERE outcome IN ('needs_review','quarantine')))::numeric
         / NULLIF(count(*), 0), 4
       ) AS review_burden,
       ((count(*) FILTER (WHERE outcome IN ('needs_review','quarantine')))::numeric
         / NULLIF(count(*), 0)) > 0.02 AS over_ceiling
  FROM decisions
 WHERE decided_at >= now() - interval '30 days'
 GROUP BY tenant_id, day
 ORDER BY day DESC, review_burden DESC;
```

`decisions_reasons_gin` exists so the second half of the question is cheap:

```sql
-- Which codes are driving review burden. This is the tuning input.
SELECT rc AS reason_code,
       count(*) AS n,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct_of_review
  FROM decisions d, unnest(d.reason_codes) AS rc
 WHERE d.outcome IN ('needs_review','quarantine')
   AND d.decided_at >= now() - interval '7 days'
 GROUP BY rc
 ORDER BY n DESC;
```

### How to tune against it

The dominant reasons for `needs_review`, in the order you will see them:

| Reason code | Cause | Tuning move | Risk of the move |
| --- | --- | --- | --- |
| `entailment.neutral` | The default lexical backend found too little token overlap | Lower the lexical floor, or accept that paraphrase is not retrievable | Recall rises, precision on unsupported specifics falls. The lexical backend's *salient-token* rule is what catches invented dates and amounts — do not weaken it to fix paraphrase |
| `entailment.below_threshold` | Backend said `entailed`, scored under `entailmentFloor` | Lower `entailmentFloor` | Direct: more false accepts. The system's one durable failure is a wrong belief, so this is the highest-consequence knob in the file |
| `entailment.unavailable` | The backend is not constructed | **Construct one.** Do not lower a threshold to route around a missing model | — |
| `authority.inference_or_hearsay` | Origin is `document` or `model_inference` | Nothing safe. Broadening `autoAcceptAuthorities` to include `hearsay` would let a hostile document auto-accept | Severe. Do not |
| `conflict.contradicts_accepted` | A competing accepted claim exists | Working as intended. The relation is recorded and a human resolves it | — |
| `kind.requires_review` | A `procedure` or `permission` | Do not remove these from `quarantineKinds` | These are the kinds that grant capability. Removing them is the single most dangerous policy edit available |
| `admission.sensitive` | `sensitivity == 'high'` | Check your ingress labelling — this usually means a typo-proofing problem, not a policy problem | — |
| `scope.broader_than_event_scope` | Should be `accept_limited_scope`, not review | See ADR 0007. If it lands in review, the containment predicate and the extractor disagree; fix the extractor's requested scope | — |

**Order of operations when the ceiling is breached:** find the dominant reason code,
check whether it is a *gate* problem or an *extractor* problem, and fix the
extractor first. An extractor that requests over-broad scopes or emits unsupported
specifics is generating review burden that no threshold change can absorb.

---

## 6. Worked examples

### 6.1 Raising the entailment floor

**Change.** `DEFAULT_COMMIT_POLICY.thresholds.entailmentFloor` from `0.5` to `0.7`.
Bump `version` to `commit-v4`.

```ts
// packages/contracts/src/policy.ts
export const GATE_THRESHOLDS: GateThresholds = {
  entailmentFloor: 0.7,          // was 0.5
  reviewBurdenCeiling: 0.02,
  lexicalEntailmentFloor: 0.6,
};

export const DEFAULT_COMMIT_POLICY: CommitPolicy = {
  version: "commit-v4",          // was "commit-v3"
  quarantineKinds: QUARANTINE_KINDS,
  autoAcceptAuthorities: AUTO_ACCEPT_AUTHORITIES,
  stalenessHorizonDays: STALENESS_HORIZON_DAYS,
  thresholds: GATE_THRESHOLDS,
};
```

**Effective only if the gate is constructed with it.** `CommitGate` uses
`dependencies.policy ?? DEFAULT_COMMIT_POLICY`, so editing the constant changes the
default and therefore every caller that does not pass a policy — of which there is
currently no production caller at all.

**What happens.** `CommitGate.evaluate()` computes:

```
entailmentOk = aggregate === "entailed" && !entailmentFloorMissed
```

so a verdict of `entailed` scoring `0.62` now sets `entailmentFloorMissed`, pushes
`entailment.below_threshold`, and the candidate takes the final `else` branch to
`needs_review`. Nothing else changes: the span checks, authority check, conflict
check and scope containment are untouched.

| Direction | Benefit | Cost |
| --- | --- | --- |
| **Raise** (0.5 → 0.7) | Fewer borderline claims become durable beliefs. The recall@k of accepted claims goes down but their precision goes up | Every affected candidate becomes review burden. At a fixed review capacity this converts an auto-accept into a stalled write. On the default lexical backend it also converts paraphrase that happened to clear 0.5 into a pile of review items, because token overlap is a weak proxy for entailment and a higher floor does not make it a better one |
| **Lower** (0.5 → 0.3) | Review burden falls; more of the corpus is retrievable | More claims accepted on weak evidence. Because the default backend is token overlap, a low floor lets a claim through on shared vocabulary alone. The salient-token rule still blocks an invented date or amount, but not a real number attached to the wrong entity |

**Verify the change before and after:**

```sql
-- Accept rate and review rate by policy version — the two numbers the floor moves
SELECT policy_version,
       count(*) FILTER (WHERE outcome = 'accept')                AS accepted,
       count(*) FILTER (WHERE outcome = 'accept_limited_scope')  AS narrowed,
       count(*) FILTER (WHERE outcome = 'needs_review')          AS review,
       count(*) FILTER (WHERE outcome = 'quarantine')            AS quarantined,
       count(*)                                                  AS total
  FROM decisions
 GROUP BY policy_version ORDER BY policy_version;
```

**The trap.** `entailmentFloor` is compared against `verdict.score`, and the *two
backends score on different scales*. `LexicalEntailmentBackend` scores the fraction
of hypothesis content tokens present in the premise — a number in `[0,1]` with a
concrete meaning. The ONNX backend scores a softmax over MNLI logits. The same
`0.5` is not the same threshold for both. If you switch backends, re-derive the floor
from measured behaviour; do not carry the number across. Note also that the ONNX
path currently feeds a placeholder tokenizer and is documented as not fit for
scoring — so in practice the only backend with a meaningful score is the lexical one.

### 6.2 Lowering the entailment floor

**Change.** `0.5` → `0.3`. Bump `version`.

**What happens.** Symmetric. The immediate measurable effect is that
`entailment.below_threshold` disappears from the reason-code histogram and
`gate.auto_accept_eligible` grows.

**The thing to watch.** Compare accepted-claim precision on LedgerBench before and
after. `fixtures/ledgerbench/05_contradiction_detection.jsonl` and
`02_unsupported_specifics` (in `fixtures/poisoning/P02_unsupported_specifics.jsonl`)
are the cases that move. **No published LedgerBench numbers exist for this
repository**, so "before" is whatever you measure yourself. Do not lower the floor on
the strength of review burden alone; lower it, then measure the unsupported-claim
component of the accept rate.

**A floor change you cannot make.** Setting `entailmentFloor` above the backend's
ability produces `needs_review` for everything and the gate stops promoting at all.
That is fail-safe, not fail-open, but it is indistinguishable from a broken backend
unless you check `entailment.below_threshold` versus `entailment.neutral` in the
histogram.

### 6.3 Tightening a staleness horizon

**Change.** `STALENESS_HORIZON_DAYS.permission` from `30` to `7`.

```ts
export const STALENESS_HORIZON_DAYS: Record<string, number> = {
  observation: 30,
  user_self_report: 365,
  preference: 365,
  event: 90,
  decision: 90,
  plan: 30,
  hypothesis: 14,
  procedure: 180,
  permission: 7,        // was 30
  derived_summary: 30,
};
```

**Effective at read time, not write time.** `stalenessHorizonFor(kind)` is called by
`evaluateUse()`, so the horizon changes the **use decision** on already-accepted
claims. A permission claim older than seven days does not become `revoked` or
`expired`; it becomes `verify` (at low or medium `action_risk`) or `deny` (at high
risk):

```ts
const weakAuthority = input.authority === "inference" || input.authority === "hearsay";
const stale = input.age_days > horizon;
…
return {
  use: input.action_risk === "high" ? "deny" : "verify",
  reason_codes: codes,     // includes use.stale
  …base,
};
```

**Bump the *use* policy version, not the commit version.** Staleness horizons live on
`CommitPolicy` for structural reasons, but the code that reads them is the read path
and the version that lands in the packet is `DEFAULT_USE_POLICY_VERSION`. Change both
if you want the packet to declare a new policy; change only `use-v2` if the commit
behaviour is unchanged. This is the one place where the two version strings are easy
to conflate, and conflating them makes a read-policy change look like a write-policy
change in the decision history.

| Direction | Benefit | Cost |
| --- | --- | --- |
| **Tighten** (30 → 7 days for `permission`) | A stale permission stops being actionable sooner. Because the horizon only degrades `use`, the claim stays retrievable and its history stays intact — an operator still sees it and its age | More `verify` decisions, which is exactly the verdict an unattended agent ignores. The implementation's own comment on `RISK_TO_ALLOWED_USE` says *"'verify first' is precisely the instruction an unattended agent will ignore"*. So tightening a horizon does not prevent a risky action; it moves the decision to the agent's judgement and labels it |
| **Loosen** (30 → 180) | Fewer interruptions for long-lived facts | A permission or procedure that has silently lapsed keeps a `use` verdict. Combined with the fact that the action gate is unimplemented, nothing downstream will catch it |

**Verify:**

```sql
-- Age distribution of currently-usable claims, by kind, against the horizon
SELECT c.kind,
       count(*) AS usable_claims,
       round(avg(extract(epoch FROM now() - c.valid_from) / 86400), 1) AS mean_age_days,
       round(max(extract(epoch FROM now() - c.valid_from) / 86400), 1) AS max_age_days
  FROM claims c
 WHERE c.status = 'accepted' AND c.valid_to IS NULL
 GROUP BY c.kind ORDER BY mean_age_days DESC;
```

**Two horizon traps.**

1. **A kind missing from the map silently inherits `DEFAULT_STALENESS_HORIZON_DAYS`
   (30).** `stalenessHorizonFor` is `STALENESS_HORIZON_DAYS[kind] ?? DEFAULT…`. If you
   add a `ClaimKind` and forget the horizon, it gets 30 days and nothing tells you.
   Add an exhaustiveness assertion to your policy document.
2. **Age is computed from `valid_from`, not `recorded_at`.** `compose()` calls
   `ageInDays(claim.valid_from, now)`. A claim extracted today from a two-year-old
   document is two years old — which is correct, and is a deliberate design point
   (`CommitGate.resolveValidFrom()` reads `events.occurred_at`). But it means
   back-dated ingestion produces instantly-stale claims, and if that surprises you,
   the fix is in the ingestion path, not the horizon.

### 6.4 Loosening a staleness horizon

Same mechanics, inverted. Loosen only with a measurement of what has actually gone
stale, and prefer to loosen a *specific* kind rather than the default. Loosening
`DEFAULT_STALENESS_HORIZON_DAYS` affects every kind you have not mapped, which is
the silent case above.

### 6.5 Changing the review-burden ceiling

Do not. It is a product target from the specification's exit criteria and kill
criteria, not a runtime parameter. It has no reader precisely so that nobody can
"fix" review burden by editing a number. If your workload genuinely cannot hold 2%,
the specification's answer is to narrow the accepted claim kinds — which is a
product decision, recorded in an ADR, not a threshold change.

### 6.6 Changing quarantine kinds

Adding a kind to `QUARANTINE_KINDS` is safe to try: it converts auto-accepts into
quarantine, raising review burden and lowering the risk of a privileged wrong belief.
Removing one is the highest-consequence edit in the policy file. `procedure` and
`permission` are the kinds that grant capability; a `procedure` claim that
auto-accepts is a durable instruction the agent may later execute. If you are
considering removing one, the correct move is to stop extracting that kind instead —
see §4, Option C.

After any quarantine change, check what it cost:

```sql
SELECT date_trunc('day', decided_at) AS day,
       count(*) FILTER (WHERE outcome = 'quarantine') AS quarantined,
       count(*) FILTER (WHERE 'kind.privileged' = ANY(reason_codes)) AS by_kind,
       count(*) AS total
  FROM decisions
 WHERE decided_at >= now() - interval '14 days'
 GROUP BY day ORDER BY day;
```

---

## 7. Using `/v1/replay` to re-evaluate an old ledger under an old policy

### The honest status

**`/v1/replay` is not implemented as a route.** `apps/server/src/` is empty.
`ReplayRequestSchema` / `ReplayResponseSchema` exist in
`packages/contracts/src/claim.ts`, and the building blocks exist:

| Piece | Where | State |
| --- | --- | --- |
| Read the whole ledger in order | `Ledger.readAll()` — keyset pagination over `(stream_id, seq)`, `ORDER BY stream_id ASC, seq ASC`, batch default 500 | Works |
| Truncate at a sequence | `readAll({ upToSeq })` | Works |
| Projection rebuild with a digest | `rebuildProjections()` | Works, under a correctly bound context |
| Lexical projection digest | `digestLexicalProjection()` | Works |
| Compare before/after | — | **Missing** |

So the operation this section describes is a procedure you assemble, not an endpoint
you call. Everything below is what the assembled procedure must do, and why.

### Why the old policy is the point

A policy change splits the decision history in two. To answer *"would today's policy
have accepted this claim?"* you re-run the gate over the ledger. To answer *"why did
the system believe this in March?"* you must re-run it under **March's** policy — and
the ledger plus `decisions.policy_version` is what lets you do that, because:

- `decisions.policy_version` on every old decision names the policy that produced it;
- `Ledger.readAll()` replays events in a deterministic order;
- `candidate` identity is deterministic — `IngestPipeline.persistCandidate()` keys a
  candidate on `(source_event_id, extractor, kind, subject, predicate, object)`, so a
  replay produces the same candidates rather than new ones;
- the entailment backend is recorded per decision
  (`GateResult.detail.entailment_backend`, `entailment_model_sha256`), so a replay
  that uses a different backend is detectable rather than silent.

### The procedure

**Step 1 — pick the ledger boundary and record it.**

```sql
SELECT COALESCE(max(seq), 0) AS watermark FROM events WHERE tenant_id = $1;
```

**Step 2 — record the four inputs a replay must pin.** A replay is only meaningful if
all four are fixed; changing any one of them makes the comparison a different
experiment.

| Input | Where it is recorded | Why it must be pinned |
| --- | --- | --- |
| Ledger watermark | The query above, or `upToSeq` | A new event changes the answer |
| Code version | Your build identifier | The decision cascade is code |
| Model hash | `projection_versions.model_sha256`, `GateResult.detail.entailment_model_sha256` | A gate model swap is a behaviour change |
| Policy version | The `CommitPolicy` you construct | This is the thing you are varying |

**Step 3 — read the ledger and re-gate.**

```ts
const replayPolicy: CommitPolicy = { ...DEFAULT_COMMIT_POLICY, version: "commit-v3" };
const gate = new CommitGate({ db, ledger, ids, clock, entailment, policy: replayPolicy });

for await (const event of ledger.readAll(executor, { tenant, upToSeq: watermark })) {
  const result = await pipeline.ingest(executor, event, { deterministicOnly: true });
  // result.decisions[i].policy_version === "commit-v3"
}
```

`deterministicOnly: true` is the important option: it pins the replay to the
deterministic extractor set and makes the run independent of whether a model endpoint
is reachable. A replay whose candidate set depends on a live model is not a replay.

**Step 4 — compare against the recorded decisions.**

```sql
SELECT d.candidate_id, d.outcome, d.policy_version, d.reason_codes
  FROM decisions d
 WHERE d.tenant_id = $1
 ORDER BY d.decided_at;
```

The comparison you want is a per-candidate diff of `outcome` and `reason_codes`. Two
kinds of difference mean different things:

| Difference | Interpretation |
| --- | --- |
| Same ledger, same policy, **different outcome** | A determinism bug or an unpinned input. Investigate before drawing any conclusion about the policy |
| Same ledger, **different policy**, different outcome | The policy effect. This is the answer you were looking for |

**Step 5 — check projection equality.** For a replay that rebuilds projections, the
equality claim is byte-identical projections for a fixed ledger, code, model hash and
policy:

```ts
const before = await digestLexicalProjection(executor, tenantId);
await rebuildProjections(executor, deps, { tenantId, truncate: true });
const after = await digestLexicalProjection(executor, tenantId);
// before.digest === after.digest  ⇔  deterministic
```

`rebuildProjections()` returns its own `{digest, rows}` for the dense and entity
projections, computed over a canonicalised row stream, and `projections.ts` says the
digest *"is what `/v1/replay` compares"*.

### Two constraints that will bite you

1. **The replay transaction needs a request context that can see the rows.** Every
   step above reads tenant data. A replay driver that binds `scopeIds: []` will
   observe an empty ledger and a zero digest and report success — the exact failure
   mode recorded in `docs/threat-model.md` §6.1 for the outbox worker and for
   `forget()`. A replay must run under an explicit privileged binding, and its
   projection rebuild must be able to distinguish "no rows" from "could not look".
2. **`rebuildProjections({ truncate: true })` is destructive to the projection.** It
   issues `DELETE FROM claim_embeddings WHERE tenant_id = $1` before reprojecting.
   That is safe — the projection is disposable by design — but it means a replay run
   against production empties the dense index for the duration. Run replays against a
   restored copy, or wait for the deferred outbox work to catch up.

### What replay does not give you

- **It does not re-evaluate old decisions in place.** Decisions are historical facts;
  a replay produces new decisions under a new version. Do not `UPDATE decisions`.
- **It does not prove the old answer was right.** It proves it was *reproducible*.
  Those are different claims and the second is the honest one.
- **It is not a substitute for a golden dataset.** Replay equality on a
  deterministically-generated ledger is easy; `fixtures/ledgerbench/` is what tests
  behaviour on adversarial input, and its runner is not wired up.

---

## 8. Changing policy: a checklist

1. **Decide which surface you are changing.** Commit policy → `commit-vN`. Use policy
   → `use-vN`. Vocabulary only → no version bump.
2. **Edit `packages/contracts/src/policy.ts`** (or pass a `CommitPolicy` object).
3. **Bump the version string**, and write down why in an ADR or a commit message that
   names the version. The version is the only thing that makes the change
   attributable later.
4. **Run `pnpm typecheck`.** `GateThresholds` and `CommitPolicy` are interfaces; a
   misspelled key is a compile error, which is the one place the raw-SQL trade-off
   does not apply.
5. **Run `pnpm test`.** `packages/contracts/src/vocabulary.test.ts` catches enum drift;
   `packages/retrieval/src/pipeline.test.ts` exercises the gate end to end.
6. **Measure before and after on a fixed ledger, at a fixed watermark, with
   `deterministicOnly: true`.** Record the watermark, code version, model hash and
   both policy versions alongside the numbers. An unrecorded comparison is an
   anecdote.
7. **Watch review burden against the 2% ceiling.** If it moves the wrong way, the
   dominant reason code tells you whether the gate or the extractor is at fault.
8. **Do not lower `entailmentFloor` to reduce review burden** unless you have also
   measured unsupported-claim auto-commit. Moving review burden into wrong beliefs is
   not a fix; it is the failure this project exists to prevent, relocated.
9. **Do not remove `procedure` or `permission` from `quarantineKinds`.**
10. **Tell the operators which reason codes to expect.** A policy change that adds a
    code changes every dashboard that filters on reason codes, and dashboards that
    silently stop matching are worse than dashboards that break.


---

# Review burden: what the number means, and how to read it

The specification sets the target as **no more than 2% of writes requiring human
review on the reference workload**, and calls review burden a *product-failure metric*
rather than an ops metric — in a CI agent at 03:00 there is no human, so a write that
needs review is a write the product could not complete.

## The denominator is the whole argument

A single rate over every write in a benchmark measures the fixture author, not the
gate. LedgerBench deliberately contains fixtures whose subject *is* a review path: the
malicious procedure, the high-sensitivity fact, the unsupported specifics, the
contradiction. If those are in the denominator then a gate that catches them is
punished for working, and the only way to improve the number is to stop catching them.

So the rate is published per write class, and only one class is compared to the ceiling.

| Class | What it means | Is review correct? | Ceiling |
| --- | --- | --- | --- |
| `ordinary` | Strong evidence, no conflict, no privileged kind, no sensitivity, no external instruction | No — this is what the ceiling measures | **2%** |
| `contradicting` | Conflicts with an accepted claim in scope | Yes — the design preserves unresolved alternatives rather than collapsing them | none |
| `high_sensitivity` | Labelled high sensitivity | Yes — sensitivity forces review whatever the evidence says | none |
| `adversarial` | Privileged kind, instruction-like external content, or evidence that does not entail the claim | Yes — this is the control functioning | none |

Measured on LedgerBench seed 1, stable across seeds 1–3:

```
ordinary           0/23 =   0.0%   <= ceiling
contradicting      2/ 2 = 100.0%
high_sensitivity   1/ 1 = 100.0%
adversarial        7/ 7 = 100.0%
```

**Read `0/23` with its size in mind.** It says the gate does not send ordinary writes to
review on these fixtures. It does not say the gate is calibrated for a production
workload, because twenty-three writes from a fixture suite is not a workload, and
because the suite's benign writes are ones the deterministic extractors were written to
handle. It is a bound on one failure mode, not a calibration.

## The rule for any future calibration

The document is explicit and it is the right rule: **reject any calibration that reaches
the review target by lowering evidence or authority requirements.** Concretely, a change
to the gate is only acceptable if, on the same seed:

- `ordinary` review burden does not rise above 2%,
- `unsafe_auto_accept_rate` stays at 0,
- `contradiction_recall` stays at 100%, and
- the poisoning fixtures' malicious-instruction acceptance stays at 0.

A gate that reaches the target by accepting contradictions has not been calibrated; it
has been disabled. `pnpm eval:ledgerbench` exits non-zero when any of those moves, so
the four are checked together rather than one at a time.
