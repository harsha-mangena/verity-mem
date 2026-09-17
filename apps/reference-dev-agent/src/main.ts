/**
 * The reference workload, runnable.
 *
 *     pnpm demo
 *     node --experimental-strip-types apps/reference-dev-agent/src/main.ts
 *     node --experimental-strip-types apps/reference-dev-agent/src/main.ts --json
 *
 * This is a demo, not a benchmark harness. It runs one scripted scenario against
 * the real database — real ledger, real gate, real projections, real retention —
 * and prints what the system did at each step, reading every number back out of the
 * tables rather than reporting what the script expected.
 *
 * Determinism, and what is deliberately *not* deterministic:
 *
 *   - the clock is `fixedClock`, so age, staleness and validity arithmetic are
 *     reproducible and every step can be checked by hand;
 *   - ids come from `seededIds`, so a run against a fresh tenant reproduces exactly;
 *   - the tenant slug is fresh per run, because ids are primary keys and the ledger
 *     is append-only. A fixed tenant would collide on the second run, and deleting
 *     rows to make room is the one thing this schema refuses.
 *
 * Both the tenant and the seed are printed at the start, so a run can be cited and
 * re-run. The id seed is folded together with the tenant slug and *that* is what is
 * printed, because `seededIds` alone is a fixed sequence: two runs sharing a seed
 * would generate the same `event_id` values, `events_pkey` would (correctly) refuse
 * the second one, and the ledger cannot delete rows to make room. Reproducibility
 * within a run is exact — same seed, same ids, same decisions — and across runs it is
 * scoped to a tenant, which is the strongest form available given that ids are
 * primary keys in an append-only store.
 */
import { fixedClock, loadEnv, seededIds } from "@veritymem/ledger";
import { DEFAULT_COMMIT_POLICY, GATE_THRESHOLDS } from "@veritymem/contracts";
import { createNarrative, percent } from "./narrative.ts";
import { runReferenceWorkload, type ReferenceRun } from "./scenario.ts";
import { PROJECT_PURPOSES, createEmbeddings, createRunnerDriver, createWorld } from "./world.ts";

/** The clock every run starts from. Changing it changes every age in the output. */
export const REFERENCE_CLOCK_START = "2026-09-01T09:00:00.000Z";

export interface DemoOptions {
  readonly seed: string;
  readonly tenantSlug: string;
  /** Capture sink for the narrative; defaults to stdout. */
  readonly write?: (line: string) => void;
  /** Whether to print the narrative at all. */
  readonly narrate?: boolean;
}

/**
 * Build a fresh tenant slug for a run.
 *
 * Time-ordered and lowercase so a run is identifiable in the database by eye, and
 * unique enough that two runs a millisecond apart cannot collide.
 */
export function freshTenantSlug(seed: string): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const suffix = seed.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return `refdev-${stamp}-${suffix}`;
}

/**
 * Run the scenario and print the narrative. Returns the structured result so a
 * caller (or a test) can assert against exactly what was printed.
 */
export async function runDemo(options: DemoOptions): Promise<ReferenceRun> {
  const env = loadEnv();
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const narrate = options.narrate ?? true;
  const narrative = createNarrative({ write });

  const clock = fixedClock(REFERENCE_CLOCK_START);
  // See the header: the tenant slug is part of the seed, so ids are unique per run
  // and deterministic within one.
  const runSeed = `${options.seed}@${options.tenantSlug}`;
  const ids = seededIds(runSeed);
  const world = createWorld({
    tenantSlug: options.tenantSlug,
    project: "payments",
    databaseUrl: env.databaseUrl,
    blobDir: `${env.repoRoot}/.veritymem/blobs`,
    clock,
    ids,
  });

  try {
    if (narrate) {
      narrative.header([
        "VerityMem — reference workload: multi-agent software delivery",
        "",
        "Nine steps against the real database: a CI tool result, a human approval, a",
        "hostile document, a cross-user isolation probe, a contradiction, a correction,",
        "a retention run, three action-gate checks, and the review-burden readout.",
        "",
        `tenant:        ${options.tenantSlug}`,
        `tenant_id:     ${world.tenantId}`,
        `seed:          ${runSeed}`,
        `  (base seed "${options.seed}" + tenant slug; ids are unique per run and`,
        "   deterministic within it, which is what an append-only key demands)",
        `clock starts:  ${REFERENCE_CLOCK_START} (fixed; +1 day per step)`,
        `commit policy: ${DEFAULT_COMMIT_POLICY.version}`,
        `purposes:      ${PROJECT_PURPOSES.join(", ")}`,
        "commands:      pnpm demo | ... main.ts --json",
      ]);
      narrative.raw("");
      narrative.raw(
        "Cite a run by its tenant and seed. The tenant is fresh per run because ids are",
      );
      narrative.raw(
        "primary keys and the ledger is append-only; the seed is what makes the ids and",
      );
      narrative.raw("the arithmetic reproducible.");
    }

    // The in-process driver builds the same processors the worker process registers
    // and drives them through the same claim loop. `pnpm demo` therefore exercises
    // the worker's code, and a reviewer who wants the out-of-process variant starts
    // `pnpm dev:worker` with WORKER_TENANT_SLUGS set to the tenant printed above.
    // One embeddings instance for the driver and the reader. Two instances with
    // different model ids is the silence described in world.ts.
    const embeddings = createEmbeddings();
    const result = await runReferenceWorkload(world, {
      driver: createRunnerDriver(world, embeddings),
      embeddings,
      policyVersion: DEFAULT_COMMIT_POLICY.version,
      ...(narrate
        ? { onStep: (step) => narrative.step(step.step, step.name, step.detail) }
        : {}),
    });

    if (narrate) {
      narrative.section("SUMMARY");
      narrative.raw(`  CI observation accepted:            ${result.ci.claim_id ?? "(none)"} (${result.ci.authority ?? "n/a"})`);
      narrative.raw(`  human approval accepted:            ${result.approval.claim_id ?? "(none)"} (${result.approval.authority ?? "n/a"})`);
      narrative.raw(`  hostile procedure accepted:         ${result.hostile.accepted_claims.length === 0 ? "no — quarantined" : "YES (defect)"}`);
      narrative.raw(
        `  isolation, same project:            teammate returned ${result.isolation.same_project.claims_returned.length} claim(s); ` +
          `reached another principal's claim: ${result.isolation.same_project.reached_other_principals_claim ? "YES (boundary not enforced)" : "no"}`,
      );
      narrative.raw(
        `  isolation, second project:          teammate returned ${result.isolation.cross_project.claims_returned.length} claim(s); ` +
          `reached another project's claim: ${result.isolation.cross_project.reached_other_principals_claim ? "YES (LEAK)" : "no"} ` +
          `(missing: ${result.isolation.cross_project.missing.length})`,
      );
      narrative.raw(
        "  The first line is the probe the specification asks for and it reports a real",
      );
      narrative.raw(
        "  gap: within one project there is no per-user boundary, because scope",
      );
      narrative.raw(
        "  containment treats an unbound dimension as reaching every binding of it.",
      );
      narrative.raw(
        "  `scope.within_event_scope` still holds at promotion time, and purposes, tenant",
      );
      narrative.raw(
        "  and project are enforced. apps/reference-dev-agent/README.md has the mechanism",
      );
      narrative.raw("  and the two candidate fixes.");
      narrative.raw(`  contradiction detected:             ${result.contradiction.reason_codes.includes("conflict.contradicts_accepted") ? "yes — needs_review" : "no (defect)"}`);
      narrative.raw(`  correction history readable:        ${result.correction.readable_after_supersession ? "yes" : "no (defect)"}; current-time query returns it: ${result.correction.in_current_query ? "yes (defect)" : "no"}`);
      narrative.raw(`  retention residual matches:         ${result.retention.residual_matches} per ${result.retention.residual_scan.length} stores (${result.retention.status})`);
      narrative.raw(`  action gate high risk on self-report: ${result.action_gate.high_risk_on_user_self_report.allowed ? "ALLOWED (defect)" : "refused"}`);
      narrative.raw(`  action gate high risk on observation: ${result.action_gate.high_risk_on_observation.allowed ? "ALLOWED (defect)" : "refused"}`);
      narrative.raw(`  action gate low risk:               ${result.action_gate.low_risk_on_user_self_report.allowed ? "allowed" : "refused (defect)"}`);
      narrative.raw("");
      narrative.raw(
        `  REVIEW BURDEN: ${result.review_burden.review_required} of ${result.review_burden.total_decisions} ` +
          `decisions = ${percent(result.review_burden.fraction)} against the ${percent(result.review_burden.ceiling)} ceiling` +
          ` -> ${result.review_burden.within_ceiling ? "within" : "ABOVE"}`,
      );
      narrative.raw(
        "  This is a product-failure metric, not an ops metric: at 03:00 in a CI agent",
      );
      narrative.raw(
        "  there is no human, so a write that needs review is a write the product could",
      );
      narrative.raw(
        "  not complete. A nine-step demo is not a calibration — it deliberately writes",
      );
      narrative.raw(
        "  adversarial content to exercise the review branches, so it sits far above 2%.",
      );
      narrative.raw(
        "  The target is measured on the full reference workload; the gap is printed",
      );
      narrative.raw("  rather than implied.");
      narrative.raw("");
      narrative.raw(`  ceiling policy: gate.reviewBurdenCeiling = ${GATE_THRESHOLDS.reviewBurdenCeiling}`);
      narrative.raw(`  rule:           ${GATE_THRESHOLDS.reviewBurdenCeiling * 100}% of writes on the reference workload`);
      narrative.raw("");
    }

    return result;
  } finally {
    await world.close();
  }
}

/** The seed a run uses when none is supplied. Chosen so the printed run is citable. */
export const DEFAULT_SEED = "reference-dev-agent-v1";

function readFlag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seed = readFlag(argv, "--seed") ?? process.env["REFERENCE_SEED"] ?? DEFAULT_SEED;
  const tenantSlug = readFlag(argv, "--tenant") ?? freshTenantSlug(seed);
  const json = argv.includes("--json");

  if (json) {
    // `--json` still runs the scenario; it just prints the structured result instead
    // of the narrative, so two runs can be diffed mechanically.
    const result = await runDemo({ seed, tenantSlug, narrate: false });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  await runDemo({ seed, tenantSlug });
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`reference workload failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
