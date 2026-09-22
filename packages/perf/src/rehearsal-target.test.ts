/**
 * Target-database safety, tested as the last line of defence it is.
 *
 * Every test here corresponds to a way a person could destroy their own working database by
 * running the rehearsal with a slightly wrong argument. The refusal is the feature.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REHEARSAL_DATABASE_PREFIX,
  SYSTEM_DATABASES,
  assertSameCluster,
  assertSelectableTarget,
  databaseNameFromUrl,
  rehearsalDatabaseName,
  validateRehearsalTarget,
  type TargetInspection,
} from "./rehearsal-target.ts";

const RECREATE_ME = ["veritymem"];

describe("reading the database name from a URL", () => {
  it("accepts a postgres:// URL with one path segment", () => {
    assert.equal(
      databaseNameFromUrl("postgres://verity:verity@127.0.0.1:55432/veritymem_rehearsal_x"),
      "veritymem_rehearsal_x",
    );
    assert.equal(
      databaseNameFromUrl("postgresql://user:pw@host:5432/veritymem_rehearsal_y"),
      "veritymem_rehearsal_y",
    );
  });

  it("refuses a URL with no database name", () => {
    assert.throws(
      () => databaseNameFromUrl("postgres://verity:verity@127.0.0.1:55432/"),
      /must name exactly one database/,
    );
  });

  it("refuses a URL with more than one path segment", () => {
    assert.throws(
      () => databaseNameFromUrl("postgres://host:5432/one/two"),
      /must name exactly one database/,
    );
  });

  it("refuses a non-PostgreSQL URL, naming the protocol it saw", () => {
    assert.throws(
      () => databaseNameFromUrl("mysql://host:3306/veritymem_rehearsal_x"),
      /must be a postgres:\/\/ URL; got mysql:\/\//,
    );
  });

  it("refuses something that is not a URL at all", () => {
    assert.throws(() => databaseNameFromUrl("veritymem_rehearsal_x"), /could not be parsed/);
  });
});

describe("validating a rehearsal target", () => {
  it("accepts a database whose name says it is a rehearsal database", () => {
    const validated = validateRehearsalTarget({
      url: "postgres://verity:verity@127.0.0.1:55432/veritymem_rehearsal_20260922_ab12cd",
      protected_names: RECREATE_ME,
    });
    assert.equal(validated.database, "veritymem_rehearsal_20260922_ab12cd");
    assert.equal(validated.protections.length, 3);
    assert.match(validated.protections.join("\n"), /differs from the configured working database/);
  });

  it("refuses the developer's own database, naming the variable that protects it", () => {
    // The single mistake this module exists to make impossible.
    assert.throws(
      () =>
        validateRehearsalTarget({
          url: "postgres://verity:verity@127.0.0.1:55432/veritymem",
          protected_names: RECREATE_ME,
        }),
      /it is the database named by the configured\s+DATABASE_URL or MIGRATION_DATABASE_URL/,
    );
  });

  it("refuses even when the protected database's name contains 'rehearsal'", () => {
    // A developer whose working database happens to be called `veritymem_rehearsal_dev` is
    // still protected: the comparison is against the configured URLs, not against the pattern.
    assert.throws(
      () =>
        validateRehearsalTarget({
          url: "postgres://verity:verity@127.0.0.1:55432/veritymem_rehearsal_dev",
          protected_names: ["veritymem_rehearsal_dev"],
        }),
      /configured\s+DATABASE_URL/,
    );
  });

  for (const system of SYSTEM_DATABASES) {
    it(`refuses the system database ${system}`, () => {
      assert.throws(
        () =>
          validateRehearsalTarget({
            url: `postgres://verity:verity@127.0.0.1:55432/${system}`,
            protected_names: RECREATE_ME,
          }),
        /is a PostgreSQL system database/,
      );
    });
  }

  it("refuses a disposable database that does not say so in its name", () => {
    assert.throws(
      () =>
        validateRehearsalTarget({
          url: "postgres://verity:verity@127.0.0.1:55432/tmp_scratch",
          protected_names: RECREATE_ME,
        }),
      /must contain\s+"rehearsal"/,
    );
  });

  it("refuses a name that cannot be interpolated into CREATE DATABASE", () => {
    // A hyphen needs quoting, and this name is interpolated into DDL where a placeholder is
    // not available.
    assert.throws(
      () =>
        validateRehearsalTarget({
          url: "postgres://host:5432/rehearsal-db-x",
          protected_names: RECREATE_ME,
        }),
      /lowercase letters, digits and underscores/,
    );
  });

  it("refuses an uppercase name before it ever reaches the identifier rule", () => {
    // `VerityMem_Rehearsal_X` does not contain the lowercase word the rule looks for, which
    // is the point: the marker must be recognisable in `pg_database` without case folding.
    assert.throws(
      () =>
        validateRehearsalTarget({
          url: "postgres://host:5432/VerityMem_Rehearsal_X",
          protected_names: RECREATE_ME,
        }),
      /must contain\s+"rehearsal"/,
    );
  });

  it("checks the protected names before anything else connects", () => {
    // The validation is synchronous and takes only strings: there is no code path in which a
    // connection is opened to a target that has not passed this.
    const validated = validateRehearsalTarget({
      url: "postgres://host:5432/veritymem_rehearsal_ok",
      protected_names: [],
    });
    assert.equal(validated.database, "veritymem_rehearsal_ok");
  });
});

describe("generating a rehearsal database name", () => {
  it("is prefixed, lowercase, self-describing and a legal identifier", () => {
    const name = rehearsalDatabaseName(new Date("2026-09-22T18:00:00.000Z"), "Ab12Cd");
    assert.ok(name.startsWith(REHEARSAL_DATABASE_PREFIX));
    assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/);
    assert.match(name, /20260922/);
    assert.match(name, /ab12cd$/);
  });

  it("differs when the suffix differs, which is what makes databases unique per run", () => {
    const at = new Date("2026-09-22T18:00:00.000Z");
    assert.notEqual(rehearsalDatabaseName(at, "aaaaaa"), rehearsalDatabaseName(at, "bbbbbb"));
  });

  it("is accepted by the validator it is built for", () => {
    const name = rehearsalDatabaseName(new Date(), "ff00ff");
    const validated = validateRehearsalTarget({
      url: `postgres://host:5432/${name}`,
      protected_names: RECREATE_ME,
    });
    assert.equal(validated.database, name);
  });
});

describe("deciding whether an existing database may be reused", () => {
  const inspection = (overrides: Partial<TargetInspection>): TargetInspection => ({
    exists: true,
    foreign_relations: [],
    marker_state: "absent",
    marker_detail: null,
    marker_label: null,
    marker_created_at: null,
    ...overrides,
  });

  it("allows a database that does not exist yet", () => {
    assert.doesNotThrow(() =>
      assertSelectableTarget(inspection({ exists: false }), "veritymem_rehearsal_new"),
    );
  });

  it("allows an empty database", () => {
    assert.doesNotThrow(() =>
      assertSelectableTarget(inspection({}), "veritymem_rehearsal_empty"),
    );
  });

  it("allows a database carrying this command's marker", () => {
    assert.doesNotThrow(() =>
      assertSelectableTarget(
        inspection({ marker_state: "valid", foreign_relations: ["claims", "events"] }),
        "veritymem_rehearsal_marked",
      ),
    );
  });

  it("refuses a lookalike marker rather than treating its table name as ownership", () => {
    assert.throws(
      () => assertSelectableTarget(inspection({ marker_state: "invalid", marker_detail: "wrong sentinel" }), "veritymem_rehearsal_x"),
      /not a valid VM-A2 ownership marker/,
    );
  });

  it("refuses a database holding unknown tables, and names them", () => {
    assert.throws(
      () =>
        assertSelectableTarget(
          inspection({ foreign_relations: ["claims", "events", "outbox"] }),
          "veritymem_rehearsal_somebody_elses",
        ),
      /no vm_a2_rehearsal marker but holds 3 relation\(s\) in public \(claims, events, outbox\)/,
    );
  });

  it("truncates a long list of unknown relations rather than printing all of them", () => {
    const many = Array.from({ length: 20 }, (_, index) => `table_${index}`);
    assert.throws(
      () => assertSelectableTarget(inspection({ foreign_relations: many }), "veritymem_rehearsal_x"),
      /table_0, table_1, table_2, table_3, table_4, table_5, table_6, table_7, …/,
    );
  });
});

describe("administrative and target server identity", () => {
  it("accepts postgres and postgresql aliases on the same host and port", () => {
    assert.doesNotThrow(() =>
      assertSameCluster(
        "postgres://owner:pw@127.0.0.1:55432/postgres",
        "postgresql://owner:pw@127.0.0.1:55432/veritymem_rehearsal_x",
      ),
    );
  });

  it("refuses a target on a different server before it can be inspected", () => {
    assert.throws(
      () =>
        assertSameCluster(
          "postgres://owner:pw@127.0.0.1:55432/postgres",
          "postgres://owner:pw@127.0.0.1:55433/veritymem_rehearsal_x",
        ),
      /differs from the configured administrative server/,
    );
  });
});
