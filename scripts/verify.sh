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

# Every failure writes a record before exiting. Without this a failed run left
# `reports/` holding only the steps that happened to run first, and the CI job's
# artifact upload -- which is configured to fail when it finds nothing -- turned a red
# gate into a red *upload*, so the evidence for the failure was the one thing missing.
# The record states `complete: false`, so a partial report cannot be mistaken for a
# finished one that simply omitted fields.
record_failure() {
  local reason="$1"
  mkdir -p "$REPORTS_DIR"
  # A completed run wrote summary.json; a failure after that point must not replace the
  # fuller record with a stub.
  if [[ -f "$REPORTS_DIR/summary.json" ]]; then
    printf '%s\n' "$reason" >> "$REPORTS_DIR/summary.json.failure"
    return 0
  fi
  # The reason reaches the child through `export`, not as a trailing `VAR=value`
  # argument: `node -e '...' VAR=value` passes the assignment as *argv* to the script, so
  # the first version of this function wrote a record with no `failure` field at all. The
  # same mistake is called out in step 9 below, which is where it was first made.
  VERITYMEM_FAILURE="$reason" REPORTS_DIR="$REPORTS_DIR" node -e '
  const fs = require("node:fs");
  const { execSync } = require("node:child_process");
  const git = (cmd, fallback) => { try { return execSync(cmd).toString().trim(); } catch { return fallback; } };
  const record = {
    complete: false,
    outcome: "failed",
    generated_at: new Date().toISOString(),
    failure: process.env.VERITYMEM_FAILURE,
    commit: git("git rev-parse HEAD", "unknown"),
    commit_short: git("git rev-parse --short HEAD", "unknown"),
    node: process.version,
    full_run: process.env.VERITYMEM_FAST === "0",
    note: "This run stopped early. The steps that completed wrote their own reports; anything absent was not run.",
  };
  fs.writeFileSync(process.env.REPORTS_DIR + "/acceptance-failure.json", JSON.stringify(record, null, 2) + "\n");
  ' 2>/dev/null \
    || printf '{\n  "complete": false,\n  "outcome": "failed",\n  "failure": "node was unavailable while recording the failure; see stdout",\n  "generated_at": "%s"\n}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
         > "$REPORTS_DIR/acceptance-failure.json"
}

fail() {
  printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2
  record_failure "$1"
  printf 'A failure record was written to %s/acceptance-failure.json.\n' "$REPORTS_DIR" >&2
  exit 1
}

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
step "3b. Workflow validity"
# ---------------------------------------------------------------------------
# The CI workflow is the one artifact this script cannot execute -- it needs a GitHub
# runner -- so it is the artifact most likely to rot unnoticed. `actionlint` statically
# validates what a runner would reject outright: expression contexts, action inputs,
# `needs` graph shape, and it shellchecks every `run:` block. It found a real defect the
# first time it ran: `name: acceptance (node ${{ env.NODE_VERSION }} ...)` is invalid,
# because `env` is not an available context in a job's `name`, and an invalid workflow is
# not a job that fails -- it is a workflow that never loads.
#
# A missing actionlint is a failure, like every other missing tool here: a check that
# silently does not run is the failure mode this script exists to prevent.
require actionlint
actionlint || fail "actionlint reported problems in .github/workflows"

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
# A red gate is recorded and the run continues, so the retained artifact contains every
# step rather than only the ones that preceded the failure. `GATE_RED` makes the script
# exit non-zero at the end: continuing is not the same as passing, and the exit code is
# still the release decision.
GATE_RED=0
GATE_REASON=""
if ! pnpm eval:ledgerbench --seed 1 \
  --out "$REPORTS_DIR/ledgerbench.json" \
  --jsonl "$REPORTS_DIR/ledgerbench-raw.jsonl" 2>&1 \
  | tee "$REPORTS_DIR/ledgerbench.txt"; then
  GATE_RED=1
  GATE_REASON="$(sed -n '/release gate FAILED/,$p' "$REPORTS_DIR/ledgerbench.txt" | head -1)"
  note "LedgerBench gate: RED — ${GATE_REASON:-see reports/ledgerbench.txt}"
  note "continuing so the retained report is complete; this run still exits non-zero"
fi

# ---------------------------------------------------------------------------
step "6b. The production entailment verifier"
# ---------------------------------------------------------------------------
# Reported rather than assumed. The model weights are 233 MB and are not committed, so a
# checkout without them cannot run the production verifier — and a release that quietly
# scored with the lexical stand-in while claiming otherwise is exactly the failure this
# report exists to prevent. The gate's own availability is therefore an explicit line in
# the acceptance output, not something a reader has to infer.
if node scripts/fetch-model.mjs --verify >/dev/null 2>&1; then
  GATE_STATE="available (digests verified)"
  node --experimental-strip-types --test packages/gate/src/onnx-entailment.test.ts \
    > "$REPORTS_DIR/onnx-entailment.txt" 2>&1 \
    || fail "the production entailment verifier failed its own tests"
  note "entailment      onnx verifier available; adversarial tests passed"
else
  GATE_STATE="ABSENT — lexical stand-in only"
  note "entailment      onnx verifier assets absent; the gate falls back to the lexical stand-in"
  note "                provision with: node scripts/fetch-model.mjs"
fi
export GATE_STATE

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
step "8b. Query-latency benchmark against the existing corpus (optional)"
# ---------------------------------------------------------------------------
# Non-blocking, and gated on the dataset already existing, for two reasons that are
# stated rather than implied.
#
# **It does not load.** Generating and projecting a million claims takes about an hour
# on a laptop, so making the acceptance run do it would turn a five-minute check into an
# hour-long one and the step would be disabled. `--skip-load` measures whatever corpus is
# already in the database and records its real size in the report.
#
# **It does not gate.** The v0.1 target is stated against a *published reference
# machine*, so a run here cannot pass or fail the release by itself; a laptop missing
# 250 ms is not a release defect, and a laptop meeting it does not close block B7. The
# exit code is checked so a crash is visible, but the verdict is read from
# `$REPORTS_DIR/perf-benchmark.txt` next to the hardware that produced it.
if [[ "${VERITYMEM_PERF:-0}" == "1" ]]; then
  export VERITYMEM_PERF_CLAIMS="${VERITYMEM_PERF_CLAIMS:-1190477}"
  if pnpm eval:perf bench --skip-load \
    --claims "$VERITYMEM_PERF_CLAIMS" \
    --workload "${VERITYMEM_PERF_WORKLOAD:-600}" \
    --reports "$REPORTS_DIR" 2>&1 | tee "$REPORTS_DIR/perf-benchmark-run.txt"; then
    PERF_P95="$(grep -E '^      p95 (current|as_of|during)' "$REPORTS_DIR/perf-benchmark.txt" 2>/dev/null | tr -s ' ' | tr '\n' ';' || true)"
    PERF_SIZE="$(grep -E '^    corpus ' "$REPORTS_DIR/perf-benchmark.txt" 2>/dev/null | head -1 | sed 's/^ *//' || true)"
    note "perf            ${PERF_SIZE:-dataset unknown}"
    note "perf p95        ${PERF_P95:-see $REPORTS_DIR/perf-benchmark.txt}"
    note "perf verdict    NOT a reference machine; evidence for block B7, not closure"
  else
    note "perf            the benchmark did not complete; see $REPORTS_DIR/perf-benchmark-run.txt"
  fi
else
  note "perf            skipped (set VERITYMEM_PERF=1 to measure the existing corpus)"
fi

# ---------------------------------------------------------------------------
step "9. Evidence summary"
# ---------------------------------------------------------------------------
# Exported rather than appended after the command: `node -e '...' VAR=value` passes the
# assignment as an argument to the script, not into its environment, and the first
# version of this step silently wrote a summary of nulls and zeros.
export PG_VERSION PGVECTOR_VERSION MIGRATION_COUNT RLS_TABLES POLICIES TESTS_PASSED GATE_STATE GATE_RED GATE_REASON
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
  production_entailment_verifier: process.env.GATE_STATE,
  full_run: process.env.VERITYMEM_FAST === "0",
  // Stated in the machine-readable record as well as on stdout: a reader of the artifact
  // alone must be able to tell a green gate from a red one.
  release_gate: process.env.GATE_RED === "1" ? "failed" : "passed",
  release_gate_reason: process.env.GATE_REASON || null,
};
fs.writeFileSync(`${process.env.REPORTS_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
'

if [[ "$GATE_RED" == "1" ]]; then
  printf '\n\033[31mAcceptance checks failed: the LedgerBench release gate is red.\033[0m\n'
  printf '%s\n' "${GATE_REASON:-see reports/ledgerbench.txt}"
  printf 'Reports retained in %s/ for commit %s.\n' "$REPORTS_DIR" "$(git rev-parse --short HEAD)"
  exit 1
fi

printf '\n\033[32mAcceptance checks passed.\033[0m\n'
printf 'Reports retained in %s/ for commit %s.\n' "$REPORTS_DIR" "$(git rev-parse --short HEAD)"
printf '\nNot covered, and stated rather than implied:\n'
printf '  * cross-tenant and revoked-grant isolation requires an independent red team (block B6)\n'
printf '  * the p95 target requires a declared reference machine at one million claims (block B7);\n'
printf '    step 8b measures it when VERITYMEM_PERF=1 and a corpus exists, and reports the verdict\n'
printf '    as evidence rather than as a release decision\n'
printf '  * review burden is reported by LedgerBench and is currently above the 2%% ceiling (block B5)\n'
