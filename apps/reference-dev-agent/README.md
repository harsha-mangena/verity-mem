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
| 4 | Cross-user isolation probe | Three probes: selector names the asker, selector names only the project, and a second project. See "Isolation" below. |
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

## Isolation

Three probes, because "isolation" is three different claims:

1. **Same project, selector names the asker.** `user:bob` asks for
   `{project: "payments", user: "bob"}`. Returns nothing, and the authorization
   read underneath the channels is empty too — the boundary is applied *before*
   retrieval, not as a filter afterwards. This is the probe the specification asks
   for and it passes.
2. **Same project, selector names only the project.** The same principal asking
   `{project: "payments"}` **does** reach the project's users. That is deliberate:
   a project-scope operator legitimately needs the whole project, and a deployment
   where this returned nothing would be broken rather than isolated. It is printed
   next to probe 1 so "narrowed by the selector" and "isolated by the deployment"
   are not confused with each other.
3. **A second project in the same tenant.** Returns nothing, resolves no reachable
   scope holding the predicate, and the teammate still receives their own billing
   claims — so the probe distinguishes a boundary from a principal who can see
   nothing at all.

The mechanism in probe 1 is that a bound selector dimension is a *requirement*:
a selector naming a user resolves only scopes that bind that user, so the project
scope drops out. Before that rule existed, a project membership reached every user
scope inside the project and `user:bob` received `user:alice`'s claims; that
regression is fixed in `packages/retrieval` and asserted both ways in
`packages/retrieval/src/isolation.test.ts`.

One consequence worth knowing, because it shapes what an adapter can do: an action
gate's plan resolves through `principal_scopes`, which is filled when a principal
*writes* in a scope. A release manager who has only ever written inside their own
user scope cannot authorise an action citing a project-scope CI claim — the gate
refuses with `action.denied_unknown_claim`. Writing a project-scope record is what
grants project membership, which is why step 4 writes one.

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
