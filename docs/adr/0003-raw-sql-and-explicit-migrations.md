# ADR 0003 — Raw SQL with `pg` and explicit migrations instead of an ORM

**Status:** Accepted · v0.1

## Context

Three properties of this system are expressed in SQL and nowhere else:

1. Row-level security policies. A policy is a `CREATE POLICY` statement naming a
   predicate function. An ORM does not have a vocabulary for it.
2. The append-only guarantees. These are `BEFORE UPDATE OR DELETE` triggers plus
   one statement-level `BEFORE DELETE` trigger whose entire purpose is the case a
   row-level trigger does not fire.
3. Bi-temporal queries. `as_of` reads transaction time (`claims.recorded_at`),
   `during` reads a `TSTZRANGE` overlap against a stored generated column. Both
   are decisions about which column is authoritative, and a query builder that
   hides them makes the decision invisible.

An ORM's value is that it prevents you from writing the wrong query. Here, the
wrong query is exactly the query that omits a scope filter — and the answer to
that is not a type-safe builder, it is a database policy that denies when the
filter is absent (see ADR 0005).

## Decision

Raw parameterised SQL through `pg`, with hand-written migrations in `migrations/`
applied by `runMigrations()` in `packages/ledger/src/migrate.ts`.

The migration runner is deliberately small and has four rules:

- Files are plain `.sql`, applied in filename order.
- Each file runs inside a transaction and is recorded in `schema_migrations` with
  a SHA-256 checksum of its text.
- A migration whose checksum no longer matches what was applied is **refused**,
  not silently re-run. The error text says to add a new migration instead.
- `--verify` fails if anything is pending and changes nothing.

Database access is funnelled through `Db.withRequest()` in `packages/ledger/src/db.ts`,
which opens one transaction per request and calls
`veritymem.set_request_context(tenant, principal, scope_ids, purposes, action)`
inside it. `Db.query()` throws when no request context is bound; the escape hatch
is `Db.systemQuery()`, which resets session state before and after and is
documented as being for statements that do not touch tenant rows.

`set_request_context` also gets called a second time inside `Ledger.append` once
the scope row is resolved, so that the write is authorized by the scope the caller
actually declared.

## Consequences

- Every policy, trigger and function is readable in the migration that created it.
  `grep -rn "row_authorized" migrations/` answers "what is the authorization
  model" without a build step.
- A schema change is reviewable as SQL by someone who does not read TypeScript.
- Migration drift is detected rather than discovered. An edited applied migration
  is an error at startup.
- **Harder:** there is no compile-time check that a query's result columns match a
  TypeScript type. The repository compensates with a `ClaimRowShape` index
  signature (`readonly [column: string]: unknown`) and explicit row mapping
  functions like `Ledger.hydrateEvent`, but a column rename is a runtime failure
  found by tests, not by `tsc`.
- **Harder:** parameter numbering is positional and long `INSERT` column lists are
  easy to get subtly wrong. `packages/claims/src/index.ts` works around this with a
  `hydrate()` helper that substitutes `$NAME$` placeholders; the ledger does not,
  and its 19-column `INSERT INTO events` is the kind of statement that a test suite
  earns its keep on.
- **Harder:** onboarding. A contributor who expects a repository layer has to read
  SQL to know what the system does.

## Alternatives rejected

**Kysely.** Named in the specification's stack table. Rejected in practice because
the repository's load-bearing SQL is not query building — it is DDL, policies,
triggers and set-returning functions, which Kysely does not model. Keeping a query
builder for the easy 30% while hand-writing the hard 70% means two idioms and one
more dependency. `AGENT-BRIEF.md` records the trade explicitly: *"Kysely-style SQL
(raw SQL with `pg`)"*.

**Prisma or TypeORM.** Rejected: both own the migration history, which would make
`schema_migrations` a second record of schema state alongside the ORM's own. Two
records of what the schema is, is one too many.

**A schema-first code generator (e.g. `pgtyped`, `sqlc`).** The closest
alternative, and not rejected on merit — a generator would recover compile-time
column checking. It is deferred because it adds a build step and a generated-code
directory before there is a stable schema to generate from. A reasonable v0.2
proposal.
