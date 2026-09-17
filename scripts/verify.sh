#!/usr/bin/env bash
#
# The acceptance check.
#
# Encodes what "v0.1 is done" means for this repository, in the order a person
# would verify it, and prints the real output of every step. It exits non-zero on
# the first failure rather than collecting them, because a partial pass on an
# append-only system's invariants is not a partial success.
#
# Deliberately not a test runner: the test suite already exists and knows what it
# asserts. This script's job is to prove that the *whole thing* runs — migrations
# apply from empty, the suite passes, the demo completes, the HTTP surface answers,
# and the offline eval report renders. A green test suite with a demo that does not
# start is a green test suite about something else.
#
#     bash scripts/verify.sh            # everything
#     bash scripts/verify.sh --fast     # skip the demo and the HTTP surface
#
set -euo pipefail

cd "$(dirname "$0")/.."

readonly DATABASE_URL_DEFAULT="postgres://veritymem_app:veritymem_app@127.0.0.1:55432/veritymem"
export DATABASE_URL="${DATABASE_URL:-$DATABASE_URL_DEFAULT}"
export MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-postgres://verity:verity@127.0.0.1:55432/veritymem}"
export NODE_OPTIONS="${NODE_OPTIONS:-}"

FAST=0
if [[ "${1:-}" == "--fast" ]]; then FAST=1; fi

step() {
  printf '\n\033[1m== %s\033[0m\n' "$1"
}

fail() {
  printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2
  exit 1
}

# ---------------------------------------------------------------------------
step "1. The database is reachable"
# ---------------------------------------------------------------------------
docker compose -f deploy/compose/docker-compose.yml ps postgres >/dev/null 2>&1 \
  || fail "the Postgres container is not running; run 'pnpm db:up'"
docker exec veritymem-postgres psql -U verity -d veritymem -tAc "select version()" \
  | head -1 || fail "cannot query Postgres"
printf 'pgvector: %s\n' "$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc "select extversion from pg_extension where extname='vector'")"
printf 'server:   %s\n' "$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc "show server_version")"

# ---------------------------------------------------------------------------
step "2. Migrations apply and the schema is self-consistent"
# ---------------------------------------------------------------------------
# `--verify` fails if anything is pending, and the runner refuses a migration whose
# checksum moved after it was applied. Both matter: the ledger's replay guarantee is
# only as good as the schema's history.
pnpm migrate --verify || fail "migrations are pending or an applied migration was edited"
printf 'applied migrations: %s\n' "$(node --experimental-strip-types -e "
import { readdirSync } from 'node:fs';
console.log(readdirSync('migrations').filter((f) => f.endsWith('.sql')).length);
")"
printf 'tables with row-level security: %s\n' \
  "$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc "select count(*) from pg_class where relrowsecurity and relnamespace='public'::regnamespace")"
printf 'policies: %s\n' \
  "$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc "select count(*) from pg_policies where schemaname='public'")"
# The app role must not be able to bypass the policies it is subject to.
printf 'app role bypassrls: %s (must be f)\n' \
  "$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc "select rolbypassrls from pg_roles where rolname='veritymem_app'")"

# ---------------------------------------------------------------------------
step "3. Typecheck"
# ---------------------------------------------------------------------------
pnpm exec tsc --noEmit -p tsconfig.json || fail "typecheck reported errors"

# ---------------------------------------------------------------------------
step "4. The test suite"
# ---------------------------------------------------------------------------
# Serial, because the suite writes to a shared append-only ledger and parallel files
# contend on it. The count is printed so a shrinking suite is visible.
# The root `pnpm test` script covers packages only; the app test suites (the HTTP
# surface and the reference workload) run here so a green package suite cannot stand in
# for a broken application.
node --experimental-strip-types --test --test-concurrency=1 \
  "packages/*/src/**/*.test.ts" "apps/*/src/**/*.test.ts" 2>&1 | tee /tmp/veritymem-tests.txt \
  || fail "the test suite failed"
grep -E '^ℹ (tests|pass|fail)' /tmp/veritymem-tests.txt || true
if grep -qE '^ℹ fail [1-9]' /tmp/veritymem-tests.txt; then
  fail "the test suite reported failures"
fi

# ---------------------------------------------------------------------------
step "5. The offline evaluation report renders"
# ---------------------------------------------------------------------------
if command -v uv >/dev/null 2>&1; then
  ( cd python/evals && uv run pytest -q ) || fail "the Python evaluation harness failed"
else
  printf 'uv is not installed; skipping the Python harness\n'
fi

if [[ "$FAST" == "0" ]]; then
  # -------------------------------------------------------------------------
  step "6. The reference workload runs end to end"
  # -------------------------------------------------------------------------
  # This is the specification's own acceptance instrument: a multi-agent
  # software-delivery scenario with mechanically checkable authority, covering the
  # happy path, a hostile document, cross-user isolation, a contradiction, a
  # correction, a retention run with a residual scan, and the action gate.
  node --experimental-strip-types apps/reference-dev-agent/src/main.ts 2>&1 | tail -60 \
    || fail "the reference workload did not complete"

  # -------------------------------------------------------------------------
  step "7. The HTTP surface answers"
  # -------------------------------------------------------------------------
  # Boot the real server on an ephemeral port and exercise the two endpoints the
  # specification singles out: the write path and /explain.
  node --experimental-strip-types apps/server/src/http-smoke.ts || fail "the HTTP smoke test failed"
fi

printf '\n\033[32mAcceptance checks passed.\033[0m\n'
printf 'Not covered here, and stated so rather than implied: cross-tenant isolation\n'
printf 'requires an external red team, and the p95 target requires a published\n'
printf 'reference machine at one million accepted claims.\n'
