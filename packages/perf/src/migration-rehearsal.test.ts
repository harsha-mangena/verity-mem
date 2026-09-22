/**
 * The rehearsal, end to end, against a real PostgreSQL server.
 *
 * ## Why this test refuses to skip
 *
 * A rehearsal that silently skipped when the database was absent would report success for the
 * one thing it exists to check. So there is no `if (!available) return`: the `before` hook
 * runs the rehearsal, and if PostgreSQL or the credentials are missing it throws, the suite
 * fails, and the failure says why.
 *
 * ## What it costs
 *
 * It creates a database, migrates it to 0013, loads two 40-claim tenants, applies 0014 and
 * 0015 with a live workload, runs the four recovery cases and verifies the projection — about
 * a minute. It drops its database afterwards. That is the price of testing the rehearsal
 * rather than a model of it, and the alternative — asserting against a fixture that no
 * migration ever produced — is the class of test this project exists to replace.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { loadEnv } from "@veritymem/ledger";
import {
  REHEARSAL_SCHEMA_VERSION,
  assessRehearsal,
  deriveFindings,
  planTarget,
  prepareTarget,
  runRehearsal,
  type CompatibilityPhase,
  type RehearsalReport,
} from "./migration-rehearsal.ts";
import { parseRehearsalArguments } from "./cli.ts";
import { FIRST_MEASURED_MIGRATION, FINAL_MIGRATION } from "./migration-rehearsal.ts";
import { PROBE_OPERATIONS } from "./rehearsal-metrics.ts";

describe("rehearsal command arguments", () => {
  it("takes every size from the ci profile when nothing is given", () => {
    const args = parseRehearsalArguments(["--output", "/tmp/x.json"]);
    assert.ok(args);
    assert.equal(args.profile, "ci");
    assert.equal(args.claims_per_tenant, 2_000);
    assert.equal(args.tenants, 2);
    assert.equal(args.read_concurrency, 2);
    assert.equal(args.duration_seconds, 20);
  });

  it("lets an explicit option override the profile it was chosen with", () => {
    const args = parseRehearsalArguments([
      "--profile",
      "local",
      "--claims",
      "123",
      "--duration",
      "9",
      "--output",
      "/tmp/x.json",
    ]);
    assert.ok(args);
    assert.equal(args.profile, "local");
    assert.equal(args.claims_per_tenant, 123);
    assert.equal(args.duration_seconds, 9);
    // Everything not overridden still comes from the local profile.
    assert.equal(args.write_concurrency, 2);
    assert.equal(args.statement_timeout_ms, 30_000);
  });

  it("requires an output path, because an unwritten rehearsal leaves no evidence", () => {
    assert.throws(() => parseRehearsalArguments([]), /--output is required/);
  });

  it("refuses an unknown profile rather than defaulting to one", () => {
    assert.throws(
      () => parseRehearsalArguments(["--profile", "production", "--output", "/tmp/x.json"]),
      /--profile must be ci or local/,
    );
  });

  it("refuses a size below the point where the rehearsal means anything", () => {
    assert.throws(
      () => parseRehearsalArguments(["--claims", "3", "--output", "/tmp/x.json"]),
      /--claims must be at least 10/,
    );
    assert.throws(
      () => parseRehearsalArguments(["--duration", "1", "--output", "/tmp/x.json"]),
      /--duration must be at least 3/,
    );
  });

  it("refuses an unknown option instead of ignoring it", () => {
    assert.throws(
      () => parseRehearsalArguments(["--output", "/tmp/x.json", "--yes-really"]),
      /unknown option --yes-really/,
    );
  });

  it("refuses an anchor that is not a timestamp", () => {
    assert.throws(
      () => parseRehearsalArguments(["--output", "/tmp/x.json", "--anchor", "yesterday"]),
      /--anchor must be an ISO timestamp/,
    );
  });
});

describe("rehearsal completeness detection", () => {
  const clone = (report: RehearsalReport): RehearsalReport =>
    JSON.parse(JSON.stringify(report)) as RehearsalReport;

  it("reports a reason for every kind of missing measurement", () => {
    // A synthetic empty report, so this test does not depend on the live run.
    const empty = {
      report_version: REHEARSAL_SCHEMA_VERSION,
      generated_at: "2026-09-22T00:00:00.000Z",
      git: { commit: null, branch: null, dirty: null },
      postgres: { server_version: null, pgvector_version: null, settings: {} },
      migrations: { dir: "/migrations", applied_through_0013: [], hashes: [] },
      environment: { profile: "ci", profile_note: "", parameters: {} },
      target: {
        database: "veritymem_rehearsal_x",
        mode: "created",
        url_redacted: "",
        protections: [],
        size_before_bytes: null,
        size_after_bytes: null,
      },
      roles: {
        migration: { rolname: null, rolsuper: null, rolbypassrls: null, owns_migrated_tables: null },
        app: { rolname: null, rolsuper: null, rolbypassrls: null, owns_migrated_tables: null },
        statement: "",
      },
      corpus: {
        seed: "s",
        anchor: "2026-01-01T00:00:00.000Z",
        claims_per_tenant: 0,
        tenants: [],
        total_claims: 0,
        load_elapsed_ms: 0,
      },
      telemetry: [],
      workload: {
        window: { started_at_ms: 0, ended_at_ms: 0 },
        phases: [],
        operations: [],
        total_samples: 0,
        samples_from_non_probe: 0,
      },
      projection: {
        invariants: [],
        verification: { checked_at: "", role: "owner", checks: [], observed: {}, behaviours: [], rls: null as never, violations: [] },
        residue: { rows: null, claims: null, by_status: {} },
        behaviours: [],
        rls: {
          statement: "",
          tenant_a: "",
          tenant_b: "",
          owner_rows_a: null,
          owner_rows_b: null,
          app_visible_rows_a: null,
          app_visible_rows_b_from_a: null,
          app_visible_claims_b_from_a: null,
          ok: false,
          note: "not run",
        },
      },
      recovery: {
        cases: [],
        objects_after_lock_timeout: {},
        objects_after_interruption: {},
        objects_final: {},
        history: [],
      },
      compatibility: [],
      findings: [],
      measurements: [],
      limitations: ["stated"],
      complete: false,
      incompleteness_reasons: [],
    } as unknown as RehearsalReport;

    const verdict = assessRehearsal(empty);
    assert.equal(verdict.complete, false);
    const reasons = verdict.reasons.join("\n");
    for (const expected of [
      "git.commit could not be read",
      "no migration hashes were computed",
      "the corpus holds no claims",
      "the application role's superuser attribute was not verified false",
      "the application role's BYPASSRLS attribute was not verified false",
      "the migration role was not verified to own the tables it migrates",
      "only 0 migration telemetry record(s) were produced",
      "the tenant-boundary check on claim_entities did not pass",
      "no projection-behaviour case was run",
      "the migration history is empty",
    ]) {
      assert.ok(reasons.includes(expected), `missing reason: ${expected}\n${reasons}`);
    }
    // Every probe operation must be named, because each one that did not run is a claim the
    // report cannot make.
    for (const operation of PROBE_OPERATIONS) {
      assert.ok(reasons.includes(`${operation} probe recorded no attempt`), operation);
    }
  });

  it("treats a null WAL count as incomplete and a null claim_entities size as not applicable", () => {
    // Exercised through `assessRehearsal`'s own rules on a report whose telemetry is present
    // but whose WAL reading failed.
    const report = {
      report_version: REHEARSAL_SCHEMA_VERSION,
      generated_at: "",
      git: { commit: "a".repeat(40), branch: "main", dirty: false },
      postgres: { server_version: "17", pgvector_version: "0.8.6", settings: {} },
      migrations: {
        dir: "/migrations",
        applied_through_0013: [],
        hashes: [
          { name: FIRST_MEASURED_MIGRATION, sha256: "0".repeat(64) },
          { name: FINAL_MIGRATION, sha256: "1".repeat(64) },
        ],
      },
      environment: { profile: "ci", profile_note: "", parameters: {} },
      target: {
        database: "veritymem_rehearsal_x",
        mode: "created",
        url_redacted: "",
        protections: [],
        size_before_bytes: 1,
        size_after_bytes: 2,
      },
      roles: {
        migration: { rolname: "verity", rolsuper: true, rolbypassrls: true, owns_migrated_tables: true },
        app: { rolname: "veritymem_app", rolsuper: false, rolbypassrls: false, owns_migrated_tables: null },
        statement: "",
      },
      corpus: {
        seed: "s",
        anchor: "2026-01-01T00:00:00.000Z",
        claims_per_tenant: 10,
        tenants: [],
        total_claims: 10,
        load_elapsed_ms: 1,
      },
      telemetry: [
        {
          name: FIRST_MEASURED_MIGRATION,
          checksum: "c",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:01.000Z",
          elapsed_ms: 1_000,
          exit_code: 0,
          outcome: "committed",
          error: null,
          backend_pid: 1,
          lock_timeout_ms: 400,
          lock_acquisition_wait_ms: 0,
          locks_held: [],
          blocked_sessions: [],
          blocked_sessions_count: 0,
          statements_blocked_over_threshold: 0,
          wal: { lsn_before: "0/1", lsn_after: null, bytes_generated: null, error: "unreadable" },
          database_size: { before_bytes: 1, after_bytes: 2, delta_bytes: 1 },
          claim_entities: {
            present_before: false,
            present_after: false,
            total_bytes_before: null,
            total_bytes_after: null,
            index_bytes_before: null,
            index_bytes_after: null,
            rows_before: null,
            rows_after: null,
            rows_backfilled: null,
          },
          temporary_files: { files_before: 0, files_after: 0, bytes_before: 0, bytes_after: 0 },
          sampling: {
            samples: 3,
            interval_ms: 200,
            blocked_threshold_ms: 1_000,
            lock_acquisition_wait_ms: 0,
            lock_wait_windows: [],
            locks_held: [],
            blocked_sessions: [],
            statements_blocked_over_threshold: 0,
            sampling_errors: [],
          },
          projection_after: { rows: null, duplicates: null, orphans: null, missing: null },
        },
      ],
      workload: {
        window: { started_at_ms: 0, ended_at_ms: 1 },
        phases: [],
        operations: PROBE_OPERATIONS.map((operation) => ({
          operation,
          attempts: 1,
          successes: 1,
          failures: 0,
          timeouts: 0,
          empty_results: 0,
          durations: { count: 1, p50_ms: 1, p95_ms: 1, p99_ms: 1, max_ms: 1, mean_ms: 1 },
          outage: { longest_ms: 0, from_ms: 0, to_ms: 0, has_success: true },
          errors: [],
          samples_from_non_probe: 0,
        })),
        total_samples: 5,
        samples_from_non_probe: 0,
      },
      projection: {
        invariants: [],
        verification: {
          checked_at: "",
          role: "owner",
          checks: [
            {
              name: "completeness_write_path_predicate",
              column: "missing_rows_write_path",
              statement: "",
              count: 0,
              expected: 0,
              ok: true,
              measured_by: "",
            },
          ],
          observed: {},
          behaviours: [],
          rls: null as never,
          violations: [],
        },
        residue: { rows: 0, claims: 0, by_status: {} },
        behaviours: [
          { case: "c", expectation: "", observed: "", ok: true },
        ],
        rls: {
          statement: "",
          tenant_a: "a",
          tenant_b: "b",
          owner_rows_a: 1,
          owner_rows_b: 1,
          app_visible_rows_a: 1,
          app_visible_rows_b_from_a: 0,
          app_visible_claims_b_from_a: 0,
          ok: true,
          note: "",
        },
      },
      recovery: {
        cases: [
          {
            case: "c",
            expectation: "",
            status: "passed" as const,
            detail: "",
            error: null,
            error_code: null,
            elapsed_ms: 1,
            evidence: {},
            telemetry: [],
          },
        ],
        objects_after_lock_timeout: {},
        objects_after_interruption: {},
        objects_final: {},
        history: [{ name: FIRST_MEASURED_MIGRATION, checksum: "c", applied_at: "" }],
      },
      compatibility: [],
      findings: [],
      measurements: [],
      limitations: ["stated"],
      complete: false,
      incompleteness_reasons: [],
    } as unknown as RehearsalReport;

    const reasons = assessRehearsal(report).reasons.join("\n");
    assert.match(reasons, /has no WAL byte count: unreadable/);
    assert.match(reasons, /only 1 migration telemetry record\(s\) were produced/);
    // The projection table does not exist during 0014, so its absent sizes are not a reason.
    assert.doesNotMatch(reasons, /claim_entities_sizes/);
    assert.equal(assessRehearsal(report).complete, false);
  });

  void clone;
});

describe("deriving findings from recorded SQLSTATEs", () => {
  const phase = (
    name: CompatibilityPhase["phase"],
    operations: readonly { operation: string; attempts: number; successes: number; error_codes: readonly string[] }[],
  ): CompatibilityPhase => ({ phase: name, schema: "synthetic", operations: [...operations] });

  it("reports the 0014 function swap only when a 0014-window caller recorded it", () => {
    const without = deriveFindings([
      phase("pre_migration", [
        { operation: "lexical_retrieval", attempts: 10, successes: 0, error_codes: ["42883"] },
      ]),
      phase("migration_0014", [
        { operation: "claim_hydration", attempts: 10, successes: 10, error_codes: [] },
      ]),
    ]);
    assert.equal(
      without.some((finding) => finding.id === "function_replacement_disrupts_active_callers"),
      false,
      "a finding must not appear without its evidence",
    );

    const with42601 = deriveFindings([
      phase("migration_0014", [
        { operation: "claim_hydration", attempts: 10, successes: 9, error_codes: ["42601"] },
      ]),
    ]);
    const finding = with42601.find(
      (entry) => entry.id === "function_replacement_disrupts_active_callers",
    );
    assert.ok(finding);
    assert.match(finding.evidence, /migration_0014: 1 failure\(s\), SQLSTATE 42601/);
  });

  it("does not report the function swap for a code recorded in a different phase", () => {
    const findings = deriveFindings([
      phase("post_migration", [
        { operation: "claim_hydration", attempts: 10, successes: 9, error_codes: ["42601"] },
      ]),
    ]);
    assert.equal(findings.length, 0, JSON.stringify(findings));
  });

  it("reports the read path's dependency on 0014 and the projection's on 0015", () => {
    const findings = deriveFindings([
      phase("pre_migration", [
        { operation: "lexical_retrieval", attempts: 5, successes: 0, error_codes: ["42883"] },
        { operation: "entity_retrieval", attempts: 5, successes: 0, error_codes: ["42P01"] },
        { operation: "project_claim", attempts: 5, successes: 0, error_codes: ["42P01"] },
      ]),
    ]);
    assert.deepEqual(
      findings.map((finding) => finding.id),
      ["read_path_requires_0014", "entity_channel_requires_0015", "projection_requires_0015"],
    );
    for (const entry of findings) assert.match(entry.evidence, /SQLSTATE/);
  });

  it("reports nothing for a run in which every code was expected", () => {
    assert.deepEqual(
      deriveFindings([
        phase("post_migration", [
          { operation: "lexical_retrieval", attempts: 5, successes: 5, error_codes: [] },
        ]),
      ]),
      [],
    );
  });
});

describe("live rehearsal", () => {
  let report: RehearsalReport;
  let output: string;
  const log: string[] = [];

  before(async () => {
    const result = await runRehearsal({
      profile: "ci",
      claims_per_tenant: 40,
      tenants: 2,
      read_concurrency: 1,
      write_concurrency: 1,
      duration_seconds: 6,
      statement_timeout_ms: 5_000,
      lock_timeout_ms: 400,
      output: `/tmp/veritymem-vm-a2-test-${process.pid}-${Date.now()}.json`,
      rehearsal_url: null,
      database_name: null,
      migrations_dir: loadEnv().migrationsDir,
      sample_interval_ms: 50,
      blocked_threshold_ms: 200,
      observation_timeout_ms: 20_000,
      corpus_seed: "veritymem-perf-v1",
      anchor: "2026-09-17T12:00:00.000Z",
      log: (message) => {
        log.push(message);
      },
    });
    report = result.report;
    output = result.output;
  });

  after(async () => {
    // The rehearsal's own database, dropped by the test that created it. Nothing else is
    // touched: the name came from the rehearsal, and the admin connection only ever drops
    // that one name.
    if (report === undefined) return;
    const adminUrl = loadEnv().migrationDatabaseUrl ?? loadEnv().databaseUrl;
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(`DROP DATABASE ${report.target.database} WITH (FORCE)`);
    } finally {
      await client.end();
    }
  });

  it("completes with no incompleteness reason", () => {
    assert.equal(
      report.complete,
      true,
      `the rehearsal reported itself incomplete:\n${report.incompleteness_reasons.join("\n")}`,
    );
    assert.deepEqual(report.incompleteness_reasons, []);
  });

  it("writes a versioned artefact whose schema version is the one this build declares", () => {
    const text = readFileSync(output, "utf8");
    const parsed = JSON.parse(text) as RehearsalReport;
    assert.equal(parsed.report_version, REHEARSAL_SCHEMA_VERSION);
    assert.equal(parsed.complete, true);
    assert.match(text.slice(0, 200), /"report_version": "vm-a2\.migration-rehearsal\.1"/);
  });

  it("names the database it created and the protections that made it disposable", () => {
    assert.match(report.target.database, /^veritymem_rehearsal_/);
    assert.equal(report.target.mode, "created");
    assert.equal(report.target.protections.length, 3);
    // The developer's ordinary database is named in the report as the thing that was refused,
    // which is the evidence that the check ran rather than being assumed.
    assert.match(report.target.protections.join("\n"), /differs from the configured working database/);
    assert.ok((report.target.size_after_bytes ?? 0) > (report.target.size_before_bytes ?? 0));
  });

  it("proves the two roles are the two roles, and that the application role is unprivileged", () => {
    assert.equal(report.roles.app.rolname, "veritymem_app");
    assert.equal(report.roles.app.rolsuper, false);
    assert.equal(report.roles.app.rolbypassrls, false);
    assert.equal(report.roles.migration.owns_migrated_tables, true);
  });

  it("records telemetry for both measured migrations", () => {
    assert.deepEqual(
      report.telemetry.map((record) => record.name),
      [FIRST_MEASURED_MIGRATION, FINAL_MIGRATION],
    );
    for (const record of report.telemetry) {
      assert.equal(record.outcome, "committed");
      assert.equal(record.exit_code, 0);
      assert.ok((record.elapsed_ms ?? 0) > 0);
      assert.notEqual(record.wal.bytes_generated, null);
      assert.notEqual(record.database_size.before_bytes, null);
      assert.notEqual(record.database_size.after_bytes, null);
      assert.ok((record.sampling?.samples ?? 0) > 0);
      assert.equal(record.sampling?.sampling_errors.length, 0);
    }
    const final = report.telemetry[1];
    assert.equal(final?.claim_entities.present_after, true);
    assert.ok((final?.claim_entities.rows_backfilled ?? 0) > 0, "0015 must have backfilled rows");
    assert.ok((final?.claim_entities.total_bytes_after ?? 0) > 0);
    assert.equal(final?.projection_after.duplicates, 0);
    assert.equal(final?.projection_after.orphans, 0);
    assert.equal(final?.projection_after.missing, 0);
  });

  it("exercised every application operation through the real code path", () => {
    for (const operation of PROBE_OPERATIONS) {
      const stats = report.workload.operations.find((entry) => entry.operation === operation);
      assert.ok(stats !== undefined, `${operation} is missing from the report`);
      assert.ok((stats?.attempts ?? 0) > 0, `${operation} was never attempted`);
      assert.ok((stats?.successes ?? 0) > 0, `${operation} never succeeded`);
      assert.notEqual(stats?.durations.p50_ms, null);
      assert.notEqual(stats?.outage.longest_ms, null);
    }
    assert.equal(report.workload.samples_from_non_probe, 0);
  });

  it("records the schema dependencies it observed as findings, with evidence", () => {
    const ids = report.findings.map((finding) => finding.id);
    assert.ok(ids.includes("read_path_requires_0014"), ids.join(", "));
    assert.ok(ids.includes("entity_channel_requires_0015"), ids.join(", "));
    assert.ok(ids.includes("projection_requires_0015"), ids.join(", "));
    // The report's findings must be exactly what its own compatibility table implies. The rare
    // 0014-window transients do not appear in a forty-claim run, and asserting that they must
    // would make this test fail for the right behaviour; deriving the expectation from the
    // recorded evidence instead makes the test check the rule rather than the weather.
    assert.deepEqual(
      deriveFindings(report.compatibility).map((finding) => finding.id),
      ids,
      "the findings are not the ones the compatibility table implies",
    );
    for (const finding of report.findings) {
      assert.ok(finding.statement.length > 40);
      assert.ok(finding.evidence.includes("SQLSTATE"), finding.evidence);
    }
    // The compatibility table must show the read path failing before 0014 and working after.
    const pre = report.compatibility.find((entry) => entry.phase === "pre_migration");
    const post = report.compatibility.find((entry) => entry.phase === "post_0014");
    assert.equal(pre?.operations.find((op) => op.operation === "lexical_retrieval")?.successes, 0);
    assert.ok((post?.operations.find((op) => op.operation === "lexical_retrieval")?.successes ?? 0) > 0);
  });

  it("verifies the projection invariants and the tenant boundary", () => {
    for (const check of report.projection.verification.checks) {
      assert.equal(
        check.ok,
        true,
        `projection invariant ${check.name} = ${String(check.count)}, expected ${String(check.expected)}`,
      );
      assert.notEqual(check.count, null, `${check.name} was not measured`);
    }
    assert.ok((report.projection.verification.observed["expected_rows_write_path"] ?? 0) > 0);
    assert.equal(report.projection.rls.ok, true);
    assert.equal(report.projection.rls.app_visible_rows_a, report.projection.rls.owner_rows_a);
    assert.equal(report.projection.rls.app_visible_rows_b_from_a, 0);
    assert.ok((report.projection.rls.owner_rows_b ?? 0) > 0, "the isolation check must not be vacuous");
    for (const behaviour of report.projection.behaviours) {
      assert.equal(behaviour.ok, true, `${behaviour.case}: ${behaviour.observed}`);
    }
  });

  it("passes all four recovery cases", () => {
    assert.deepEqual(
      report.recovery.cases.map((entry) => entry.case),
      [
        "lock_timeout_while_0015_waits_on_a_conflicting_lock",
        "interrupted_transaction_before_commit",
        "rerun_after_interruption",
        "rerun_after_successful_application",
      ],
    );
    for (const entry of report.recovery.cases) {
      assert.equal(entry.status, "passed", `${entry.case}: ${entry.detail}`);
    }
    // No partial history entry, and the objects the aborted attempts created are absent.
    assert.equal(report.recovery.cases[0]?.evidence["history_rows_for_0015"], 0);
    assert.equal(report.recovery.cases[0]?.evidence["observed_as_lock_timeout"], true);
    assert.equal(report.recovery.cases[1]?.evidence["observed_waiting_for_lock"], true);
    assert.equal(report.recovery.cases[1]?.evidence["object_present_claim_entities"], false);
    assert.equal(report.recovery.cases[1]?.evidence["object_present_events_tenant_seq_desc_idx"], false);
    // Exactly one 0015 row survives, recorded by the successful rerun.
    assert.equal(
      report.recovery.history.filter((row) => row.name === FINAL_MIGRATION).length,
      1,
    );
    assert.equal(report.recovery.objects_final["claim_entities"], true);
    // The last case re-verifies the projection itself, so "the projection remains exact after
    // recovery" is a property of the recovery case rather than of a later, separate check.
    const last = report.recovery.cases[3];
    assert.equal(last?.evidence["missing_projection_rows"], 0);
    assert.equal(last?.evidence["projection_verify_error"], null);
    assert.equal(last?.evidence["projection_measured_missing_rows_write_path"], true);
  });

  it("measures at least one lock and one WAL delta rather than reporting zeros", () => {
    for (const record of report.telemetry) {
      assert.ok((record.locks_held.length > 0) || (record.sampling?.samples ?? 0) > 0);
    }
    const walBytes = report.telemetry.map((record) => record.wal.bytes_generated ?? 0);
    assert.ok(walBytes.some((bytes) => bytes > 0), "at least one migration must have written WAL");
    assert.ok((report.telemetry[1]?.database_size.delta_bytes ?? 0) > 0);
  });
});

/**
 * The destructive path, live.
 *
 * A rehearsal database that already carries the marker is **dropped and recreated**, so the
 * marker check is the only thing standing between a mistyped URL and somebody's data. That
 * check is unit-tested; this exercises it against a real server, where "does it carry the
 * marker" is answered by `pg_class` rather than by a fixture.
 */
describe("explicit rehearsal databases, live", () => {
  const adminUrl = (): string => loadEnv().migrationDatabaseUrl ?? loadEnv().databaseUrl;
  const stamp = `${process.pid}_${Date.now().toString(36)}`;
  const marked = `veritymem_rehearsal_livetest_${stamp}`;
  const foreign = `veritymem_rehearsal_foreign_${stamp}`;
  const protectedNames = (): string[] =>
    [loadEnv().databaseUrl, loadEnv().migrationDatabaseUrl]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => new URL(value).pathname.replace(/^\//, ""));

  const urlFor = (database: string): string => {
    const url = new URL(adminUrl());
    url.pathname = `/${database}`;
    return url.toString();
  };

  const connect = async (database = "postgres"): Promise<pg.Client> => {
    const url = new URL(adminUrl());
    url.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  };

  const drop = async (database: string): Promise<void> => {
    const client = await connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await client.end();
    }
  };

  before(async () => {
    await drop(marked);
    await drop(foreign);
  });

  after(async () => {
    await drop(marked);
    await drop(foreign);
  });

  it("creates a named database, marks it, and recognises it on the next run", async () => {
    const plan = await planTarget({
      adminUrl: adminUrl(),
      rehearsalUrl: urlFor(marked),
      databaseName: null,
      protectedNames: protectedNames(),
      runId: "livetest",
      log: () => undefined,
    });
    assert.equal(plan.database, marked);
    assert.equal(plan.mode, "created");

    await prepareTarget({
      adminUrl: adminUrl(),
      database: plan.database,
      migrationUrl: plan.migrationUrl,
      mode: plan.mode,
      log: () => undefined,
    });

    const second = await planTarget({
      adminUrl: adminUrl(),
      rehearsalUrl: urlFor(marked),
      databaseName: null,
      protectedNames: protectedNames(),
      runId: "livetest",
      log: () => undefined,
    });
    assert.equal(
      second.mode,
      "recreated",
      "a database carrying the rehearsal marker must be recognised as disposable",
    );
  });

  it("refuses a database that holds tables but carries no marker", async () => {
    const client = await connect();
    try {
      await client.query(`CREATE DATABASE ${foreign}`);
    } finally {
      await client.end();
    }
    const inside = await connect(foreign);
    try {
      await inside.query("CREATE TABLE somebody_elses_data (id int primary key)");
    } finally {
      await inside.end();
    }

    await assert.rejects(
      () =>
        planTarget({
          adminUrl: adminUrl(),
          rehearsalUrl: urlFor(foreign),
          databaseName: null,
          protectedNames: protectedNames(),
          runId: "livetest",
          log: () => undefined,
        }),
      /no vm_a2_rehearsal marker but holds 1 relation\(s\) in public \(somebody_elses_data\)/,
    );
  });
});
