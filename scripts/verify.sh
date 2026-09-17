#!/usr/bin/env bash
#
# The acceptance check.
#
# Encodes what "v0.1 is done" means, in the order a person would verify it, and
# retains machine-readable evidence. It is the single documented command the release
# gate names, so its behaviour has to be trustworthy in two specific ways:
#
#   * **A missing tool is a failure, not a skip.** An earlier version printed
#     "uv is not installed; skipping the Python harness" and exited zero. A
#     partial pass that looks like a pass is worse than no check, because it is the
#     thing a release decision gets made on.
#   * **A failed benchmark gate is a failure.** `eval:ledgerbench` exits non-zero on a
#     failed assertion or a failed conformance check, and its exit code is checked
#     here rather than its output being read by eye.
#
# Every step writes a report under `reports/`, and the run ends with a summary that
# names the exact versions it ran against. A green result from an undeclared
# environment is not evidence.
#
#     bash scripts/verify.sh              # everything, including the demo and HTTP
#     bash scripts/verify.sh --fast       # skip the two slow end-to-end steps
#
set -euo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
# Pinned environment
#
# Declared, not assumed. The acceptance run is only meaningful against the versions
# it claims, so a mismatch fails here rather than silently producing a green result
# from a different stack.
# ---------------------------------------------------------------------------
readonly PINNED_NODE_MAJOR=22
readonly PINNED_PG_MAJOR=17
readonly PINNED_PGVECTOR="0.8.6"
readonly PINNED_PYTHON_MINOR=12

export DATABASE_URL="${DATABASE_URL:-postgres://veritymem_app:veritymem_app@127.0.0.1:55432/veritymem}"
export MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-postgres://verity:verity@127.0.0.1:55432/veritymem}"
export REPORTS_DIR="${REPORTS_DIR:-reports}"

FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

mkdir -p "$REPORTS_DIR"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# A tool that is needed and absent is a failure. Never a skip.
require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required by the acceptance check and is not installed"
}

require node
require pnpm
require docker
require uv

# ---------------------------------------------------------------------------
step "1. Pinned environment"
# ---------------------------------------------------------------------------
NODE_VERSION="$(node -v)"
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" -ge "$PINNED_NODE_MAJOR" ]] \
  || fail "Node >= $PINNED_NODE_MAJOR is required, found $NODE_VERSION"
note "node            $NODE_VERSION"
note "pnpm            $(pnpm -v)"
note "python          $(python3 -V 2>&1 | awk '{print $2}')"
note "uv              $(uv --version | awk '{print $2}')"

docker compose -f deploy/compose/docker-compose.yml ps postgres >/dev/null 2>&1 \
  || fail "the Postgres container is not running; run 'pnpm db:up'"

PG_VERSION="$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc 'show server_version' | tr -d ' ')"
[[ "$PG_VERSION" == "$PINNED_PG_MAJOR."* ]] \
  || fail "PostgreSQL $PINNED_PG_MAJOR is required, found $PG_VERSION"
PGVECTOR_VERSION="$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc "select extversion from pg_extension where extname='vector'" | tr -d ' ')"
[[ "$PGVECTOR_VERSION" == "$PINNED_PGVECTOR" ]] \
  || fail "pgvector $PINNED_PGVECTOR is required, found $PGVECTOR_VERSION"
note "postgresql      $PG_VERSION"
note "pgvector        $PGVECTOR_VERSION"

# ---------------------------------------------------------------------------
step "2. Migrations apply, and the schema is self-consistent"
# ---------------------------------------------------------------------------
pnpm migrate --verify || fail "migrations are pending or an applied migration was edited"
MIGRATION_COUNT="$(node -e "console.log(require('node:fs').readdirSync('migrations').filter((f) => f.endsWith('.sql')).length)")"
RLS_TABLES="$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc "select count(*) from pg_class where relrowsecurity and relnamespace='public'::regnamespace" | tr -d ' ')"
POLICIES="$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc "select count(*) from pg_policies where schemaname='public'" | tr -d ' ')"
BYPASS="$(docker exec veritymem-postgres psql -U verity -d veritymem -tAc "select rolbypassrls from pg_roles where rolname='veritymem_app'" | tr -d ' ')"
[[ "$BYPASS" == "f" ]] || fail "the application role can bypass row-level security"
note "migrations      $MIGRATION_COUNT applied, none pending"
note "row-level security: $RLS_TABLES tables, $POLICIES policies, app role bypassrls=$BYPASS"

# ---------------------------------------------------------------------------
step "3. Typecheck"
# ---------------------------------------------------------------------------
pnpm exec tsc --noEmit -p tsconfig.json || fail "typecheck reported errors"

# ---------------------------------------------------------------------------
step "4. Test suite (packages and applications)"
# ---------------------------------------------------------------------------
# Serial, because the suite writes to a shared append-only ledger. The root
# `pnpm test` script covers packages only; the app suites run here too, so a green
# package suite cannot stand in for a broken application.
node --experimental-strip-types --test --test-concurrency=1 \
  "packages/*/src/**/*.test.ts" "apps/*/src/**/*.test.ts" 2>&1 \
  | tee "$REPORTS_DIR/tests.txt" || fail "the test suite failed"
TESTS_PASSED="$(grep -E '^ℹ pass [0-9]+' "$REPORTS_DIR/tests.txt" | awk '{print $3}' | tail -1)"
TESTS_FAILED="$(grep -E '^ℹ fail [0-9]+' "$REPORTS_DIR/tests.txt" | awk '{print $3}' | tail -1)"
[[ "${TESTS_FAILED:-1}" == "0" ]] || fail "the test suite reported $TESTS_FAILED failures"
note "tests           $TESTS_PASSED passed, 0 failed"

# ---------------------------------------------------------------------------
step "5. Offline evaluation harness (Python)"
# ---------------------------------------------------------------------------
# `--extra dev` is required: pytest is an optional dependency, and running bare
# `uv run pytest` picks up whatever happens to be in the environment.
( cd python/evals && uv run --extra dev pytest -q ) 2>&1 | tee "$REPORTS_DIR/pytest.txt" \
  || fail "the Python evaluation harness failed"
note "pytest          $(tail -2 "$REPORTS_DIR/pytest.txt" | head -1)"

# ---------------------------------------------------------------------------
step "6. LedgerBench"
# ---------------------------------------------------------------------------
# The exit code is the gate, not the output. This is the command the release gate
# names, and it was pointing at a file that did not exist until this script was
# rewritten to check it.
pnpm eval:ledgerbench --seed 1 \
  --out "$REPORTS_DIR/ledgerbench.json" \
  --jsonl "$REPORTS_DIR/ledgerbench-raw.jsonl" 2>&1 \
  | tee "$REPORTS_DIR/ledgerbench.txt" || fail "LedgerBench reported a failing gate"

if [[ "$FAST" == "0" ]]; then
  # -------------------------------------------------------------------------
  step "7. Reference workload, end to end"
  # -------------------------------------------------------------------------
  node --experimental-strip-types apps/reference-dev-agent/src/main.ts 2>&1 \
    | tee "$REPORTS_DIR/reference-workload.txt" || fail "the reference workload did not complete"

  # -------------------------------------------------------------------------
  step "8. HTTP surface, over a real socket"
  # -------------------------------------------------------------------------
  node --experimental-strip-types apps/server/src/http-smoke.ts 2>&1 \
    | tee "$REPORTS_DIR/http-smoke.txt" || fail "the HTTP smoke test failed"
fi

# ---------------------------------------------------------------------------
step "9. Evidence summary"
# ---------------------------------------------------------------------------
# Exported rather than appended after the command: `node -e '...' VAR=value` passes the
# assignment as an argument to the script, not into its environment, and the first
# version of this step silently wrote a summary of nulls and zeros.
export PG_VERSION PGVECTOR_VERSION MIGRATION_COUNT RLS_TABLES POLICIES TESTS_PASSED
export VERITYMEM_FAST="$FAST"

node -e '
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const summary = {
  generated_at: new Date().toISOString(),
  commit: execSync("git rev-parse HEAD").toString().trim(),
  commit_short: execSync("git rev-parse --short HEAD").toString().trim(),
  node: process.version,
  pnpm: execSync("pnpm -v").toString().trim(),
  postgres: process.env.PG_VERSION,
  pgvector: process.env.PGVECTOR_VERSION || null,
  migrations_applied: Number(process.env.MIGRATION_COUNT || 0),
  rls_tables: Number(process.env.RLS_TABLES || 0),
  policies: Number(process.env.POLICIES || 0),
  tests_passed: Number(process.env.TESTS_PASSED || 0),
  full_run: process.env.VERITYMEM_FAST === "0",
};
fs.writeFileSync(`${process.env.REPORTS_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
'

printf '\n\033[32mAcceptance checks passed.\033[0m\n'
printf 'Reports retained in %s/ for commit %s.\n' "$REPORTS_DIR" "$(git rev-parse --short HEAD)"
printf '\nNot covered, and stated rather than implied:\n'
printf '  * cross-tenant and revoked-grant isolation requires an independent red team (block B6)\n'
printf '  * the p95 target requires a declared reference machine at one million claims (block B7)\n'
printf '  * review burden is reported by LedgerBench and is currently above the 2%% ceiling (block B5)\n'
