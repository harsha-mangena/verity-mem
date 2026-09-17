/**
 * Vocabulary drift guard.
 *
 * Every closed vocabulary exists twice: once as a Postgres enum and once as a
 * TypeScript union. Nothing in either language can see the other, so they drift
 * silently — a new claim kind added to the enum and not to the union produces a
 * runtime failure at the least convenient moment, and a member removed from the
 * union but left in the enum leaves dead values in the database.
 *
 * This test reads the actual enum labels out of `pg_enum` and compares them to
 * the TypeScript tuples, in both directions. It is the only test in the suite that
 * is allowed to fail for a purely declarative reason, and it should: a schema
 * change is exactly when a human needs to look.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  AUTHORITY_CLASSES,
  CANDIDATE_STATES,
  CLAIM_KINDS,
  CLAIM_STATUSES,
  DECISION_OUTCOMES,
  EVIDENCE_ROLES,
  ENTAILMENT_RESULTS,
  ORIGIN_KINDS,
  RELATION_KINDS,
  RETENTION_MODES,
  RETENTION_STATES,
  SENSITIVITIES,
  TOOL_PROFILES,
  USE_DECISIONS,
  isKnownReasonCode,
  REASON_CODE_VALUES,
} from "@veritymem/contracts";
import { Db, loadEnv } from "@veritymem/ledger";

interface EnumExpectation {
  readonly pg_type: string;
  readonly ts_values: readonly string[];
  readonly label: string;
}

const ENUM_EXPECTATIONS: readonly EnumExpectation[] = [
  { pg_type: "origin_kind", ts_values: ORIGIN_KINDS, label: "origin kinds" },
  { pg_type: "authority_cls", ts_values: AUTHORITY_CLASSES, label: "authority classes" },
  { pg_type: "claim_status", ts_values: CLAIM_STATUSES, label: "claim statuses" },
  { pg_type: "claim_kind", ts_values: CLAIM_KINDS, label: "claim kinds" },
  { pg_type: "decision_outcome", ts_values: DECISION_OUTCOMES, label: "decision outcomes" },
  { pg_type: "relation_kind", ts_values: RELATION_KINDS, label: "relation kinds" },
  { pg_type: "evidence_role", ts_values: EVIDENCE_ROLES, label: "evidence roles" },
  { pg_type: "candidate_state", ts_values: CANDIDATE_STATES, label: "candidate states" },
  { pg_type: "retention_mode", ts_values: RETENTION_MODES, label: "retention modes" },
  { pg_type: "retention_state", ts_values: RETENTION_STATES, label: "retention states" },
];

describe("contract vocabulary", () => {
  let db: Db;

  before(() => {
    db = new Db({ connectionString: loadEnv().databaseUrl, max: 2 });
  });

  after(async () => {
    await db.close();
  });

  for (const expectation of ENUM_EXPECTATIONS) {
    it(`matches the database enum for ${expectation.label}`, async () => {
      const result = await db.systemQuery<{ label: string }>(
        `SELECT e.enumlabel AS label
           FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = $1
          ORDER BY e.enumsortorder`,
        [expectation.pg_type],
      );
      const dbValues = result.rows.map((row) => row.label);
      assert.ok(dbValues.length > 0, `no enum labels found for ${expectation.pg_type}`);

      // Both directions. A missing member breaks writes; a surplus member means
      // the union is more permissive than the database and the failure will
      // surface as a Postgres error rather than a type error.
      const inTsNotDb = expectation.ts_values.filter((value) => !dbValues.includes(value));
      const inDbNotTs = dbValues.filter((value) => !(expectation.ts_values as readonly string[]).includes(value));
      assert.deepEqual(
        inTsNotDb,
        [],
        `declared in TypeScript but absent from the ${expectation.pg_type} enum: ${inTsNotDb.join(", ")}`,
      );
      assert.deepEqual(
        inDbNotTs,
        [],
        `present in the ${expectation.pg_type} enum but not declared in TypeScript: ${inDbNotTs.join(", ")}`,
      );
    });
  }

  it("keeps every vocabulary member unique", () => {
    const vocabs: readonly (readonly string[])[] = [
      ORIGIN_KINDS,
      AUTHORITY_CLASSES,
      CLAIM_STATUSES,
      CLAIM_KINDS,
      DECISION_OUTCOMES,
      RELATION_KINDS,
      EVIDENCE_ROLES,
      CANDIDATE_STATES,
      RETENTION_MODES,
      RETENTION_STATES,
      SENSITIVITIES,
      USE_DECISIONS,
      ENTAILMENT_RESULTS,
      TOOL_PROFILES,
    ];
    for (const vocab of vocabs) {
      assert.equal(new Set(vocab).size, vocab.length, `duplicate member in ${vocab.join(",")}`);
    }
  });

  it("keeps reason codes recognisable as closed-set members", () => {
    const codes = [...REASON_CODE_VALUES];
    assert.ok(codes.length > 40, "reason code list looks truncated");
    assert.equal(new Set(codes).size, codes.length, "duplicate reason code");
    for (const code of codes) {
      assert.ok(isKnownReasonCode(code), `${code} is not recognised by its own registry`);
      // Reason codes are dotted namespaces so /explain can group them by stage.
      assert.match(code, /^[a-z_]+\.[a-z_]+$/, `reason code ${code} is not namespaced by stage`);
    }
  });

  it("does not emit a single confidence number anywhere in the packet claim shape", async () => {
    // The hard API rule, asserted structurally rather than trusted: the packet
    // claim type must expose the six dimensions and must not expose `confidence`.
    const { MemoryPacketSchema } = await import("@veritymem/contracts");
    const packet = MemoryPacketSchema as unknown as {
      properties: { claims: { items: { properties: Record<string, unknown> } } };
    };
    const claimProps = Object.keys(packet.properties.claims.items.properties);
    assert.ok(!claimProps.includes("confidence"), "MemoryPacket.claims[].confidence must not exist");
    for (const required of ["authority", "use", "freshness", "conflicts", "evidence", "signals"]) {
      assert.ok(claimProps.includes(required), `MemoryPacket.claims[] is missing ${required}`);
    }
  });
});
