# `@veritymem/reference-dev-agent`

The reference workload: multi-agent software delivery, end to end against a real
database. This is the demo entry point and the eval substrate — `src/main.ts` runs
it for a person, `src/reference.test.ts` runs the *same function* and asserts what
it observed, so the demo and the test cannot drift apart.

## Run

```bash
pnpm db:up        # Postgres 17 + pgvector on 127.0.0.1:55432
pnpm migrate
pnpm demo         # the nine-step narrative

# or directly
node --experimental-strip-types apps/reference-dev-agent/src/main.ts
node --experimental-strip-types apps/reference-dev-agent/src/main.ts --json
node --experimental-strip-types apps/reference-dev-agent/src/main.ts --seed my-seed --tenant my-tenant

# the same scenario as assertions
node --experimental-strip-types --test apps/reference-dev-agent/src/reference.test.ts
```

`--json` runs the scenario and prints the structured `ReferenceRun` instead of the
narrative, for diffing two runs. `--seed` reproduces the id sequence; `--tenant`
pins the tenant, which is otherwise fresh per run.

## The nine steps, and why each one is here

| # | Step | What it demonstrates |
| --- | --- | --- |
| 1 | CI tool result (`origin: "tool"`) | Auto-accepted with `observation` authority, evidence span resolved and digest re-verified on the read. |
| 2 | Human approval (`origin: "user"`) | Accepted with `user_self_report` authority. Two different authority classes, both above the auto-accept floor. |
| 3 | Hostile document (`origin: "document"`) | The procedure candidate is **quarantined**, never accepted, and the reason codes are printed verbatim. |
| 4 | Cross-user isolation probe | Two probes: same project different user, and a second project. See "Isolation" below — the first reports a real gap. |
| 5 | A second, incompatible approval | `needs_review` with `conflict.contradicts_accepted`. The first claim is untouched: no silent overwrite. |
| 6 | Action gate, three verdicts | High risk refuses both a `user_self_report` and a tool `observation`; low risk permits one. |
| 7 | Correction | Supersession closes the validity interval; the old claim stays readable through `/explain`-equivalent reads while a current-time query stops returning it. |
| 8 | Retention, `forget()` for one subject | Per-store residual scan, all zero, job `verified`. The ledger row survives with its content hash and no payload. |
| 9 | Review-burden readout | The fraction of decisions that needed a human, printed against the 2% ceiling the specification sets. |

The order is not the specification's numbered order. The action gate runs before
the correction because the correction supersedes the claim the action gate cites,
and a superseded claim is correctly unusable — testing the gate afterwards would
measure the supersession, not the risk rule.

## Determinism: the clock is fixed, the tenant is not

- The clock is `fixedClock("2026-09-01T09:00:00.000Z")` and advances exactly one
  day per step. Age, staleness horizons and validity arithmetic are therefore
  reproducible and can be checked by hand: the run spans nine days, and the
  shortest staleness horizon on any claim it writes is 30 days.
- Ids come from `seededIds(seed + "@" + tenantSlug)`. The tenant is folded into the
  seed on purpose: `seededIds` alone produces a fixed sequence, so two runs sharing
  a seed would generate the same `event_id`, `events_pkey` would refuse the second
  one, and an append-only ledger cannot delete rows to make room. Reproducibility
  is exact *within* a run and scoped to a tenant *across* runs, which is the
  strongest form available when ids are primary keys.
- The tenant slug is fresh per run and both the tenant and the effective seed are
  printed at the top, so a run can be cited and re-run.

Every number the narrative prints is read back out of `events`, `claims`,
`decisions`, `claim_evidence`, `retention_jobs` or a query plan. Nothing is
accumulated in memory by the caller, because a scenario that reported its own
numbers could report flattering ones.

## Isolation: what holds, and what does not

**Holds.** Tenant, purpose and project boundaries are enforced before retrieval.
The second-project probe returns no claim from the first project, and its
authorization read finds no reachable scope holding the predicate at all — the
boundary is applied *before* retrieval, not as a filter afterwards. The probe is
not vacuous: the same principal reaches project-scope claims inside their own
project, and the project's owner reaches them too.

**Does not hold.** Per-user isolation inside one project. This is a package-level
property, not a defect in this app:

- `veritymem.scope_contains` (migration 0007) treats a `NULL` dimension on the
  *caller's* scope as reaching every binding of that dimension on the row's scope.
  Its comment states this is deliberate and asymmetric.
- So a principal whose only membership is `project=payments` reaches every
  `user=<someone>` scope inside `payments`.
- `resolveScopes` never intersects the selector with the caller's reach, and a
  selector that names a user is applied as a filter over the caller's scopes — so
  naming yourself is *more* restrictive, not less: `{project, user: bob}` resolves
  to no scope at all, while `{project}` reaches every user in the project.

Observed in this workload: `user:bob` asks for Alice's approved deploy window at
the project scope and receives Alice's `decision.approved` claim, whose scope is
`project=payments, user=alice`. The run prints this as
`reached_other_principals_claim: true` rather than asserting the isolation the
specification asks for, and `src/reference.test.ts` pins the observed value so it
cannot change silently. If reach is fixed, that test fails loudly and the probe
should be inverted — which is the intended failure direction.

Two candidate fixes, both in packages or migrations rather than here: make the
reach rule symmetric in the user dimension so a project membership reaches only
project-scope rows, or have `resolveScopes` intersect the selector with the reach
set so `{project, user: bob}` is a narrowing rather than an empty set. The first is
the smaller change and matches what a reader expects "user scope" to mean.

A related consequence worth knowing, because it shapes what an adapter can do: an
action gate's plan resolves only through `principal_scopes`, which is filled when a
principal *writes* in a scope. A release manager who has only ever written inside
their own user scope cannot authorise an action citing a project-scope CI claim —
the gate refuses with `action.denied_unknown_claim`. Writing a project-scope record
is what grants project membership, which is why step 4 writes one.

## Review burden is a product-failure metric

Step 9 prints the fraction of gate decisions that required a human and compares it
to `GATE_THRESHOLDS.reviewBurdenCeiling` (2%). The specification is explicit that
this is a product-failure metric rather than an ops metric: in a CI agent at 03:00
there is no human, so a write that needs review is a write the product could not
complete.

**A nine-step demo is not a calibration.** It deliberately writes adversarial
content — a hostile document, two incompatible approvals — in order to exercise the
review branches, so its fraction sits far above 2% by construction. The 2% target
is measured on the full reference workload. The number is printed with that
statement attached rather than left to imply a calibration it is not.

## Files

| File | Why it exists |
| --- | --- |
| `src/main.ts` | Entry point: builds the world, runs the scenario, prints the narrative, prints the citable tenant and seed. |
| `src/scenario.ts` | The nine steps. Exported so the test asserts the demo's behaviour rather than a re-implementation of it. |
| `src/world.ts` | Tenants, the worker driver seam, the shared embedding backend, and the raw reads (`scopeVisibility`, `readEvidence`, `reviewBurden`). |
| `src/narrative.ts` | Plain-text rendering. `write` is injectable so the test can assert what the run *printed*. |
| `src/reference.test.ts` | `node:test` over the same scenario: one assertion group per step, plus an assertion that the narrative names the tenant, the seed and every residual-scan store. |

## Dependencies on the worker

`src/world.ts` imports `createClaimLoop` and `createOutboxRunner` from
`apps/worker/src/`. That is deliberate: the demo drives the *worker's* code path,
so a demo that passes and a worker that cannot claim are not two separate facts.
See `apps/worker/README.md` for the port notice explaining why the claim loop lives
in the worker rather than in `@veritymem/ledger`.
