# Contributing to VerityMem

## Sign-off, not a CLA

Contributions are accepted under the **Developer Certificate of Origin**. Add a
`Signed-off-by` line to every commit:

```
git commit -s -m "your message"
```

That is the whole legal mechanism. There is no contributor licence agreement to
sign, because a project that argues against gatekeeping should not gatekeep its own
contributions.

## Before you open a pull request

```bash
pnpm install -r
pnpm db:up
pnpm migrate
pnpm typecheck     # must be clean
pnpm test          # must be green
```

A pull request that changes behaviour without changing or adding a test will be
asked for one. This is not process for its own sake: the two most serious defects
found in this codebase so far — an empty purpose array acting as a wildcard, and two
OR'd row-level-security policies letting the cheaper clause decide visibility — were
both found by tests that asserted a *negative* (nothing is reachable, nothing is
accepted) rather than a positive. Negative assertions are the ones that find
authorization bugs, so they are the ones reviewers look for.

## What makes a change easy to accept

- **A failing test first.** Show the bug, then fix it.
- **A comment that records why.** The code already says *what* it does. A comment is
  valuable when it records a constraint, a rejected alternative, or a subtlety that a
  future reader would otherwise "fix".
- **A migration, never an edit.** Migrations are checksummed and an applied migration
  is immutable. If you need to change the schema, add `migrations/00NN_*.sql`. If the
  runner refuses your migration because you edited one that was already applied, that
  is the runner working correctly — add a new one.
- **A self-check inside a schema migration.** If your migration changes an
  authorization rule, prove the rule in the same transaction, in the style of
  `migrations/0005` through `0009`. A migration that constructs its own test rows and
  rolls back is worth more than one that selects whatever happens to be in the
  database, because the latter silently passes on an empty table.

## Things that will be rejected

- **Any change that lets a model call set `claims.status`.** The gate is the only
  promotion path and the database enforces it (`migrations/0010`). If you need a new
  promotion route, extend the gate and the policy, not the write privilege.
- **Any change that filters after retrieval.** Authorization runs before search. A
  candidate the caller cannot reach must never be a candidate, because filtering
  afterwards leaks through counts, timings and summaries.
- **A single confidence number.** Six dimensions stay separate on every returned
  claim: extractor confidence, evidence entailment, authority class, freshness,
  conflict state, policy use decision. Averaging them destroys interpretability and
  invites unsafe thresholding. This is an API rule, not a style preference.
- **An LLM call on the default read path.** Reranking and synthesis are opt-in, and a
  memory layer must not make latency, cost and reproducibility depend on another
  opaque model call.
- **A new runtime dependency without a stated reason.** The stack is fixed by the
  specification: Fastify, TypeBox, raw SQL with `pg`, pgvector, the Postgres outbox,
  the official MCP TypeScript SDK, ONNX Runtime Node for entailment.
- **Marketing language that implies verification.** Entailment is a filter. Publish
  its false-negative rate; never claim the system is verified.

## Adding a table that carries tenant data

It needs row-level security and a policy on `veritymem.row_authorized(tenant, scope)`,
or on the tenant alone if it has no scope column. Then extend the self-check in
`migrations/0009` — it asserts that no table has RLS enabled without a policy, so a
new table with RLS and no policy fails the migration rather than shipping.

## Reporting a security issue

Do not open a public issue. See `SECURITY.md`.
