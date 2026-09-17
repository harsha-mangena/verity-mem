/**
 * The strict fixture parser.
 *
 * Strict here means two things, and both are load-bearing:
 *
 *  - **A malformed line is an error, never a skip.** A fixture runner that skips
 *    what it cannot read reports a 100% pass rate on the lines it happened to
 *    understand, which is worse than reporting nothing.
 *  - **A malformed line names its location.** Every failure carries the file and
 *    the 1-based line number, because an unactionable failure gets deleted.
 *
 * Validation is written by hand rather than generated from the TypeBox schemas.
 * The schemas in `@veritymem/contracts` are the contract for the *wire* format and
 * are validated separately for the nested event; what this module adds is the
 * fixture grammar — line kinds, expectation cross-references, reason codes against
 * the closed set — and precise error locations, which a generic validator cannot
 * give. The event object itself is checked against `EventAppendRequestSchema` so a
 * schema change cannot pass unnoticed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AUTHORITY_CLASSES,
  type EventAppendRequest,
  CLAIM_KINDS,
  CLAIM_STATUSES,
  DECISION_OUTCOMES,
  EventAppendRequestSchema,
  ORIGIN_KINDS,
  RELATION_KINDS,
  SENSITIVITIES,
  isKnownReasonCode,
} from "@veritymem/contracts";
import { FixtureParseError, type FixtureErrorCode } from "./errors.ts";
import {
  ACTIONS,
  ERASE_MODES,
  EXPECTATION_TYPES,
  GROUND_TRUTH_LEVELS,
  RESOLVE_OUTCOMES,
  SUITES,
  SUPPORTED_FIXTURE_VERSIONS,
  type ClaimMatch,
  type ConformanceDecisionAssertion,
  type ConformanceOutcome,
  type ConformanceRelationAssertion,
  type ConformanceTrace,
  type Expectation,
  type FixtureBodyLine,
  type FixtureCandidate,
  type FixtureFile,
  type FixtureHeader,
  type FixtureLoadReport,
  type FixtureSpan,
  type Suite,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Primitive readers. Each names the field it wanted, so the message is actionable.
// ---------------------------------------------------------------------------

/**
 * TypeBox leaves semantic `format` keywords to the host, so `date-time` is
 * unregistered until something registers it. The contract schema declares
 * `format: "date-time"` *and* an RFC 3339 pattern; without this the pattern is
 * still enforced but TypeBox reports "Unknown format" first, which is a
 * misleading error for a fixture author. Registering the same rule the pattern
 * expresses keeps the fixture error message about the fixture.
 */
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set(
    "date-time",
    (value: string) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
  );
}

type Json = Record<string, unknown>;

function fail(file: string, line: number, code: FixtureErrorCode, message: string): never {
  throw new FixtureParseError(file, line, code, message);
}

function asObject(file: string, line: number, value: unknown, what: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(file, line, "wrong_type", `${what} must be an object, got ${describe(value)}`);
  }
  return value as Json;
}

function field(file: string, line: number, source: Json, key: string): unknown {
  if (!(key in source)) fail(file, line, "missing_field", `missing required field \`${key}\``);
  return source[key];
}

function requiredString(
  file: string,
  line: number,
  source: Json,
  key: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = field(file, line, source, key);
  if (typeof value !== "string") {
    fail(file, line, "wrong_type", `\`${key}\` must be a string, got ${describe(value)}`);
  }
  if (!options.allowEmpty && value.trim() === "") {
    fail(file, line, "empty_value", `\`${key}\` must not be empty`);
  }
  return value;
}

function optionalString(file: string, line: number, source: Json, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    fail(file, line, "wrong_type", `\`${key}\` must be a string when present, got ${describe(value)}`);
  }
  if (value.trim() === "") fail(file, line, "empty_value", `\`${key}\` must not be empty when present`);
  return value;
}

function requiredNumber(file: string, line: number, source: Json, key: string): number {
  const value = field(file, line, source, key);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(file, line, "wrong_type", `\`${key}\` must be a finite number, got ${describe(value)}`);
  }
  return value;
}

function optionalNumber(file: string, line: number, source: Json, key: string): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(file, line, "wrong_type", `\`${key}\` must be a finite number when present, got ${describe(value)}`);
  }
  return value;
}

function optionalBoolean(file: string, line: number, source: Json, key: string): boolean | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    fail(file, line, "wrong_type", `\`${key}\` must be a boolean when present, got ${describe(value)}`);
  }
  return value;
}

function stringArray(file: string, line: number, source: Json, key: string, options: { minItems?: number } = {}): string[] {
  const value = field(file, line, source, key);
  if (!Array.isArray(value)) {
    fail(file, line, "wrong_type", `\`${key}\` must be an array, got ${describe(value)}`);
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      fail(file, line, "wrong_type", `\`${key}[${index}]\` must be a string, got ${describe(entry)}`);
    }
    if (entry.trim() === "") fail(file, line, "empty_value", `\`${key}[${index}]\` must not be empty`);
    out.push(entry);
  }
  if (options.minItems !== undefined && out.length < options.minItems) {
    fail(file, line, "empty_value", `\`${key}\` must have at least ${options.minItems} entry`);
  }
  return out;
}

function optionalStringArray(file: string, line: number, source: Json, key: string): string[] | undefined {
  if (source[key] === undefined || source[key] === null) return undefined;
  return stringArray(file, line, source, key);
}

function optionalObject(file: string, line: number, source: Json, key: string): Json | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  return asObject(file, line, value, `\`${key}\``);
}

function oneOf<T extends string>(
  file: string,
  line: number,
  value: string,
  allowed: readonly T[],
  what: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  fail(file, line, "unknown_vocabulary", `${what} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
}

function isIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function requireInstant(file: string, line: number, value: string, what: string): string {
  if (!isIsoInstant(value)) {
    fail(
      file,
      line,
      "bad_instant",
      `${what} must be an RFC 3339 instant with an explicit UTC offset, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function checkReasonCodes(file: string, line: number, codes: readonly string[], what: string): readonly string[] {
  for (const code of codes) {
    if (!isKnownReasonCode(code)) {
      fail(
        file,
        line,
        "unknown_reason_code",
        `${what} uses ${JSON.stringify(code)}, which is not in REASON_CODES. ` +
          `Reason codes are a closed set because the review-burden metric and the gate calibration loop read them.`,
      );
    }
  }
  return codes;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "string") return `string(${JSON.stringify(value.slice(0, 40))})`;
  return typeof value;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * Read a header line.
 *
 * `fallbackVersion` exists for conformance documents, which are single JSON
 * objects rather than JSONL and therefore carry no header line of their own.
 */
export function parseHeader(file: string, line: number, source: Json): FixtureHeader {
  const fixtureVersion = requiredString(file, line, source, "fixture_version");
  if (!SUPPORTED_FIXTURE_VERSIONS.includes(fixtureVersion)) {
    fail(
      file,
      line,
      "unsupported_version",
      `fixture_version ${JSON.stringify(fixtureVersion)} is not supported by this build ` +
        `(supported: ${SUPPORTED_FIXTURE_VERSIONS.join(", ")}). Bump the reader and the fixture together.`,
    );
  }
  const suite = oneOf(file, line, requiredString(file, line, source, "suite"), SUITES, "`suite`");
  const groundTruth = oneOf(
    file,
    line,
    requiredString(file, line, source, "ground_truth"),
    GROUND_TRUTH_LEVELS,
    "`ground_truth`",
  );
  return {
    kind: "header",
    line,
    fixture_version: fixtureVersion,
    dataset_version: requiredString(file, line, source, "dataset_version"),
    fixture_id: requiredString(file, line, source, "fixture_id"),
    suite,
    title: requiredString(file, line, source, "title"),
    ground_truth: groundTruth,
    ...(optionalString(file, line, source, "notes") !== undefined
      ? { notes: optionalString(file, line, source, "notes") as string }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

function parseClaimMatch(file: string, line: number, source: Json): ClaimMatch {
  const subject = optionalString(file, line, source, "subject");
  const predicate = optionalString(file, line, source, "predicate");
  const tenant = optionalString(file, line, source, "tenant");
  return {
    ...(subject !== undefined ? { subject } : {}),
    ...(predicate !== undefined ? { predicate } : {}),
    ...("object" in source ? { object: source["object"] } : {}),
    ...(source["kind"] !== undefined
      ? { kind: oneOf(file, line, requiredString(file, line, source, "kind"), CLAIM_KINDS, "`kind`") }
      : {}),
    ...(source["status"] !== undefined
      ? { status: oneOf(file, line, requiredString(file, line, source, "status"), CLAIM_STATUSES, "`status`") }
      : {}),
    ...(tenant !== undefined ? { tenant } : {}),
  };
}

export function parseExpectation(file: string, line: number, value: unknown, index: number): Expectation {
  const source = asObject(file, line, value, `expect[${index}]`);
  const type = requiredString(file, line, source, "type");
  if (!(EXPECTATION_TYPES as readonly string[]).includes(type)) {
    fail(
      file,
      line,
      "unsupported_expectation",
      `expect[${index}].type ${JSON.stringify(type)} is not a known expectation ` +
        `(known: ${EXPECTATION_TYPES.join(", ")})`,
    );
  }

  // `expect_conflict` uses `kind` for the relation, not the claim kind, so it must
  // not go through the shared claim-match reader.
  // Three expectation types reuse field names for non-claim meanings: a conflict's
  // `kind` is a relation, a deletion's `status` is the retention job state, and a
  // grant has no claim match at all. Reading them as claim matches would fail the
  // fixture for a collision in the grammar rather than a defect in the system.
  const usesClaimMatch =
    type !== "expect_conflict" &&
    type !== "expect_relation_persisted" &&
    type !== "expect_deleted" &&
    type !== "expect_grant";
  const match = usesClaimMatch ? parseClaimMatch(file, line, source) : {};

  switch (type as Expectation["type"]) {
    case "expect_claim": {
      const scope = optionalObject(file, line, source, "scope");
      const parsedScope =
        scope === undefined
          ? undefined
          : {
              ...(optionalString(file, line, scope, "project") !== undefined
                ? { project: optionalString(file, line, scope, "project") as string }
                : {}),
              ...(optionalString(file, line, scope, "user") !== undefined
                ? { user: optionalString(file, line, scope, "user") as string }
                : {}),
              ...(optionalString(file, line, scope, "agent") !== undefined
                ? { agent: optionalString(file, line, scope, "agent") as string }
                : {}),
              ...(optionalString(file, line, scope, "session") !== undefined
                ? { session: optionalString(file, line, scope, "session") as string }
                : {}),
              ...(optionalStringArray(file, line, scope, "purpose") !== undefined
                ? { purpose: optionalStringArray(file, line, scope, "purpose") as string[] }
                : {}),
            };
      return {
        type: "expect_claim",
        ...(match as ClaimMatch),
        ...(parsedScope !== undefined ? { scope: parsedScope } : {}),
      };
    }
    case "expect_no_claim": {
      const scope = optionalObject(file, line, source, "scope");
      const parsedScope =
        scope === undefined
          ? undefined
          : {
              ...(optionalString(file, line, scope, "project") !== undefined
                ? { project: optionalString(file, line, scope, "project") as string }
                : {}),
              ...(optionalString(file, line, scope, "user") !== undefined
                ? { user: optionalString(file, line, scope, "user") as string }
                : {}),
              ...(optionalString(file, line, scope, "agent") !== undefined
                ? { agent: optionalString(file, line, scope, "agent") as string }
                : {}),
              ...(optionalString(file, line, scope, "session") !== undefined
                ? { session: optionalString(file, line, scope, "session") as string }
                : {}),
              ...(optionalStringArray(file, line, scope, "purpose") !== undefined
                ? { purpose: optionalStringArray(file, line, scope, "purpose") as string[] }
                : {}),
            };
      return {
        type: "expect_no_claim",
        ...(match as ClaimMatch),
        ...(parsedScope !== undefined ? { scope: parsedScope } : {}),
      };
    }
    case "expect_quarantined":
      return { type: "expect_quarantined", ...((match as ClaimMatch).kind !== undefined ? { kind: (match as ClaimMatch).kind } : {}) };
    case "expect_needs_review":
      return { type: "expect_needs_review", ...((match as ClaimMatch).kind !== undefined ? { kind: (match as ClaimMatch).kind } : {}) };
    case "expect_scope_narrowed":
      return { type: "expect_scope_narrowed", ...((match as ClaimMatch).kind !== undefined ? { kind: (match as ClaimMatch).kind } : {}) };
    case "expect_conflict":
    case "expect_relation_persisted": {
      return {
        type: type as "expect_conflict" | "expect_relation_persisted",
        kind: oneOf(file, line, requiredString(file, line, source, "kind"), RELATION_KINDS, "`kind`"),
        subject: requiredString(file, line, source, "subject"),
        ...(optionalString(file, line, source, "predicate") !== undefined
          ? { predicate: optionalString(file, line, source, "predicate") as string }
          : {}),
        ...("object" in source ? { object: source["object"] } : {}),
        ...(optionalString(file, line, source, "against_subject") !== undefined
          ? { against_subject: optionalString(file, line, source, "against_subject") as string }
          : {}),
        ...(optionalString(file, line, source, "against_predicate") !== undefined
          ? { against_predicate: optionalString(file, line, source, "against_predicate") as string }
          : {}),
        ...("against_object" in source ? { against_object: source["against_object"] } : {}),
      };
    }
    case "expect_revoked":
      return { type: "expect_revoked", ...(match as ClaimMatch) };
    case "expect_superseded":
      return { type: "expect_superseded", ...(match as ClaimMatch) };
    case "expect_missing":
      return {
        type: "expect_missing",
        query: requiredString(file, line, source, "query"),
        ...(optionalString(file, line, source, "contains") !== undefined
          ? { contains: optionalString(file, line, source, "contains") as string }
          : {}),
      };
    case "expect_reason": {
      const mustInclude = optionalStringArray(file, line, source, "must_include");
      const mustExclude = optionalStringArray(file, line, source, "must_exclude");
      const lineId = optionalString(file, line, source, "line_id");
      if ((mustInclude ?? []).length === 0 && (mustExclude ?? []).length === 0) {
        fail(
          file,
          line,
          "empty_expectation",
          "expect_reason must declare at least one of `must_include` or `must_exclude`; an empty reason assertion always passes",
        );
      }
      if (mustInclude) checkReasonCodes(file, line, mustInclude, "expect_reason.must_include");
      if (mustExclude) checkReasonCodes(file, line, mustExclude, "expect_reason.must_exclude");
      return {
        type: "expect_reason",
        ...(mustInclude !== undefined ? { must_include: mustInclude } : {}),
        ...(mustExclude !== undefined ? { must_exclude: mustExclude } : {}),
        ...(lineId !== undefined ? { line_id: lineId } : {}),
      };
    }
    case "expect_grant": {
      const expiresAt = optionalString(file, line, source, "expires_at");
      if (expiresAt !== undefined) requireInstant(file, line, expiresAt, "expect_grant.expires_at");
      const expired = optionalBoolean(file, line, source, "expired");
      return {
        type: "expect_grant",
        subject: requiredString(file, line, source, "subject"),
        ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
        ...(expired !== undefined ? { expired } : {}),
      };
    }
    case "expect_deleted": {
      const residual = requiredNumber(file, line, source, "residual_matches");
      if (!Number.isInteger(residual) || residual < 0) {
        fail(file, line, "wrong_type", "expect_deleted.residual_matches must be a non-negative integer");
      }
      return {
        type: "expect_deleted",
        stores: stringArray(file, line, source, "stores", { minItems: 1 }),
        residual_matches: residual,
        status: requiredString(file, line, source, "status"),
      };
    }
    case "expect_residual_scan": {
      const storesRaw = field(file, line, source, "stores");
      const stores = asObject(file, line, storesRaw, "expect_residual_scan.stores");
      const parsedStores: Record<string, number> = {};
      for (const [store, count] of Object.entries(stores)) {
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
          fail(
            file,
            line,
            "wrong_type",
            `expect_residual_scan.stores.${store} must be a non-negative integer, got ${describe(count)}`,
          );
        }
        parsedStores[store] = count;
      }
      if (Object.keys(parsedStores).length === 0) {
        fail(file, line, "empty_expectation", "expect_residual_scan.stores must name at least one store");
      }
      const preserved = optionalNumber(file, line, source, "ledger_rows_preserved");
      if (preserved !== undefined && (!Number.isInteger(preserved) || preserved < 0)) {
        fail(file, line, "wrong_type", "expect_residual_scan.ledger_rows_preserved must be a non-negative integer");
      }
      return {
        type: "expect_residual_scan",
        stores: parsedStores,
        ...(preserved !== undefined ? { ledger_rows_preserved: preserved } : {}),
      };
    }
    case "expect_unverifiable_claim": {
      const codes = optionalStringArray(file, line, source, "reason_codes");
      if (codes) checkReasonCodes(file, line, codes, "expect_unverifiable_claim.reason_codes");
      return {
        type: "expect_unverifiable_claim",
        ...(match as ClaimMatch),
        ...(codes !== undefined ? { reason_codes: codes } : {}),
      };
    }
    default:
      fail(file, line, "unsupported_expectation", `unhandled expectation type ${JSON.stringify(type)}`);
  }
}

function parseExpectations(file: string, line: number, source: Json): Expectation[] {
  const value = field(file, line, source, "expect");
  if (!Array.isArray(value)) {
    fail(file, line, "wrong_type", "`expect` must be an array (use [] when the line asserts nothing)");
  }
  return value.map((entry, index) => parseExpectation(file, line, entry, index));
}

// ---------------------------------------------------------------------------
// Body lines
// ---------------------------------------------------------------------------

function parseSpan(file: string, line: number, value: unknown, index: number): FixtureSpan {
  const source = asObject(file, line, value, `candidate.spans[${index}]`);
  const start = optionalNumber(file, line, source, "start");
  const end = optionalNumber(file, line, source, "end");
  const quote = optionalString(file, line, source, "quote");
  if (start === undefined && quote === undefined) {
    fail(
      file,
      line,
      "bad_span",
      `candidate.spans[${index}] needs either \`quote\` or an explicit \`start\`/\`end\` pair`,
    );
  }
  if ((start === undefined) !== (end === undefined)) {
    fail(file, line, "bad_span", `candidate.spans[${index}] must give \`start\` and \`end\` together`);
  }
  if (start !== undefined && end !== undefined) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) {
      fail(file, line, "bad_span", `candidate.spans[${index}] offsets must be non-negative integers`);
    }
    if (end <= start) {
      fail(file, line, "bad_span", `candidate.spans[${index}] end (${end}) must be greater than start (${start})`);
    }
  }
  const role = optionalString(file, line, source, "role");
  if (role !== undefined && role !== "supports" && role !== "refutes") {
    fail(file, line, "unknown_vocabulary", `candidate.spans[${index}].role must be supports or refutes`);
  }
  const occurrence = optionalNumber(file, line, source, "occurrence");
  if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 0)) {
    fail(file, line, "bad_span", `candidate.spans[${index}].occurrence must be a non-negative integer`);
  }
  return {
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(quote !== undefined ? { quote } : {}),
    ...(role !== undefined ? { role: role as "supports" | "refutes" } : {}),
    ...(optionalString(file, line, source, "selector") !== undefined
      ? { selector: optionalString(file, line, source, "selector") as string }
      : {}),
    ...(occurrence !== undefined ? { occurrence } : {}),
  };
}

function parseCandidate(file: string, line: number, value: unknown): FixtureCandidate {
  const source = asObject(file, line, value, "`candidate`");
  const kind = oneOf(file, line, requiredString(file, line, source, "kind"), CLAIM_KINDS, "candidate.kind");
  const authority = optionalString(file, line, source, "authority");
  if (authority !== undefined && !(AUTHORITY_CLASSES as readonly string[]).includes(authority)) {
    fail(
      file,
      line,
      "unknown_vocabulary",
      `candidate.authority must be one of ${AUTHORITY_CLASSES.join(", ")}, got ${JSON.stringify(authority)}`,
    );
  }
  const confidence = optionalNumber(file, line, source, "confidence");
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
    fail(file, line, "wrong_type", "candidate.confidence must be between 0 and 1");
  }
  const spansRaw = field(file, line, source, "spans");
  if (!Array.isArray(spansRaw)) fail(file, line, "wrong_type", "candidate.spans must be an array");
  // A candidate with no evidence is a legitimate thing to test — the gate must
  // reject it — but the fixture has to say so deliberately, not by omission.
  if (spansRaw.length === 0 && source["empty_spans_intended"] !== true) {
    fail(
      file,
      line,
      "bad_span",
      "candidate.spans is empty; set `empty_spans_intended: true` on the candidate to assert the no-evidence path",
    );
  }
  const requestedScope = optionalObject(file, line, source, "requested_scope");
  const parsedRequested =
    requestedScope === undefined
      ? undefined
      : {
          ...(optionalString(file, line, requestedScope, "tenant") !== undefined
            ? { tenant: optionalString(file, line, requestedScope, "tenant") as string }
            : {}),
          ...(optionalString(file, line, requestedScope, "project") !== undefined
            ? { project: optionalString(file, line, requestedScope, "project") as string }
            : {}),
          ...(optionalString(file, line, requestedScope, "user") !== undefined
            ? { user: optionalString(file, line, requestedScope, "user") as string }
            : {}),
          ...(optionalString(file, line, requestedScope, "agent") !== undefined
            ? { agent: optionalString(file, line, requestedScope, "agent") as string }
            : {}),
          ...(optionalString(file, line, requestedScope, "session") !== undefined
            ? { session: optionalString(file, line, requestedScope, "session") as string }
            : {}),
          ...(optionalStringArray(file, line, requestedScope, "purpose") !== undefined
            ? { purpose: optionalStringArray(file, line, requestedScope, "purpose") as string[] }
            : {}),
        };

  return {
    kind,
    subject: requiredString(file, line, source, "subject"),
    predicate: requiredString(file, line, source, "predicate"),
    object: field(file, line, source, "object"),
    spans: spansRaw.map((entry, index) => parseSpan(file, line, entry, index)),
    ...(authority !== undefined ? { authority } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(parsedRequested !== undefined ? { requested_scope: parsedRequested } : {}),
  };
}

/**
 * Validate the nested event against the real contract schema.
 *
 * This is the one place the fixture format cannot afford to be approximate: if a
 * fixture event is not a valid `EventAppendRequest`, the fixture is testing a
 * request shape the server would reject at the edge.
 */
function parseEvent(file: string, line: number, value: unknown): EventAppendRequest {
  const source = asObject(file, line, value, "`event`");
  if (!Value.Check(EventAppendRequestSchema, source)) {
    const first = [...Value.Errors(EventAppendRequestSchema, source)][0];
    const path = first?.path ?? "";
    fail(
      file,
      line,
      "wrong_type",
      `event does not satisfy EventAppendRequest at ${path || "<root>"}: ${first?.message ?? "unknown"}`,
    );
  }
  return source as unknown as EventAppendRequest;
}

function parseLineId(file: string, line: number, source: Json): string {
  return requiredString(file, line, source, "line_id");
}

export function parseBodyLine(file: string, line: number, value: unknown): FixtureBodyLine {
  const source = asObject(file, line, value, "fixture line");
  const action = oneOf(file, line, requiredString(file, line, source, "action"), ACTIONS, "`action`");
  const lineId = parseLineId(file, line, source);
  const expect = parseExpectations(file, line, source);
  const note = optionalString(file, line, source, "note");

  switch (action) {
    case "append_event": {
      // `origin` and `sensitivity` are validated by the event schema itself, but
      // check the closed vocabularies here too so the error names the fixture line
      // rather than a JSON pointer into a nested object.
      const event = parseEvent(file, line, field(file, line, source, "event"));
      if (!(ORIGIN_KINDS as readonly string[]).includes(event.origin)) {
        fail(file, line, "unknown_vocabulary", `event.origin ${JSON.stringify(event.origin)} is not an origin kind`);
      }
      if (event.sensitivity !== undefined && !(SENSITIVITIES as readonly string[]).includes(event.sensitivity)) {
        fail(
          file,
          line,
          "unknown_vocabulary",
          `event.sensitivity ${JSON.stringify(event.sensitivity)} is not one of ${SENSITIVITIES.join(", ")}`,
        );
      }
      const candidateRaw = source["candidate"];
      return {
        kind: "append_event",
        line,
        line_id: lineId,
        event,
        ...(candidateRaw !== undefined ? { candidate: parseCandidate(file, line, candidateRaw) } : {}),
        expect,
        ...(note !== undefined ? { note } : {}),
      };
    }
    case "create_grant": {
      const grant = asObject(file, line, field(file, line, source, "grant"), "`grant`");
      const pattern = asObject(file, line, field(file, line, grant, "resource_pattern"), "grant.resource_pattern");
      const expiresAt = optionalString(file, line, grant, "expires_at");
      if (expiresAt !== undefined) requireInstant(file, line, expiresAt, "grant.expires_at");
      const purpose = stringArray(file, line, grant, "purpose", { minItems: 1 });
      return {
        kind: "create_grant",
        line,
        line_id: lineId,
        grant: {
          subject: requiredString(file, line, grant, "subject"),
          resource_pattern: {
            tenant: requiredString(file, line, pattern, "tenant"),
            ...(optionalString(file, line, pattern, "project") !== undefined
              ? { project: optionalString(file, line, pattern, "project") as string }
              : {}),
            ...(optionalString(file, line, pattern, "user") !== undefined
              ? { user: optionalString(file, line, pattern, "user") as string }
              : {}),
            ...(optionalString(file, line, pattern, "agent") !== undefined
              ? { agent: optionalString(file, line, pattern, "agent") as string }
              : {}),
            ...(optionalString(file, line, pattern, "session") !== undefined
              ? { session: optionalString(file, line, pattern, "session") as string }
              : {}),
          },
          actions: stringArray(file, line, grant, "actions", { minItems: 1 }),
          purpose,
          ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
        },
        expect,
        ...(note !== undefined ? { note } : {}),
      };
    }
    case "resolve_claim": {
      const target = asObject(file, line, field(file, line, source, "target"), "`target`");
      const codes = stringArray(file, line, source, "reason_codes", { minItems: 1 });
      checkReasonCodes(file, line, codes, "resolve_claim.reason_codes");
      return {
        kind: "resolve_claim",
        line,
        line_id: lineId,
        target: parseClaimMatch(file, line, target),
        outcome: oneOf(file, line, requiredString(file, line, source, "outcome"), RESOLVE_OUTCOMES, "`outcome`"),
        reason: requiredString(file, line, source, "reason"),
        reason_codes: codes,
        expect,
        ...(note !== undefined ? { note } : {}),
      };
    }
    case "erase_subject": {
      const subject = asObject(file, line, field(file, line, source, "subject_or_scope"), "`subject_or_scope`");
      const mode = oneOf(file, line, requiredString(file, line, source, "mode"), ERASE_MODES, "`mode`");
      const redactActor = optionalBoolean(file, line, source, "redact_actor_events");
      return {
        kind: "erase_subject",
        line,
        line_id: lineId,
        subject_or_scope: {
          ...(optionalString(file, line, subject, "tenant") !== undefined
            ? { tenant: optionalString(file, line, subject, "tenant") as string }
            : {}),
          ...(optionalString(file, line, subject, "project") !== undefined
            ? { project: optionalString(file, line, subject, "project") as string }
            : {}),
          ...(optionalString(file, line, subject, "user") !== undefined
            ? { user: optionalString(file, line, subject, "user") as string }
            : {}),
          ...(optionalString(file, line, subject, "agent") !== undefined
            ? { agent: optionalString(file, line, subject, "agent") as string }
            : {}),
          ...(optionalString(file, line, subject, "session") !== undefined
            ? { session: optionalString(file, line, subject, "session") as string }
            : {}),
          ...(optionalString(file, line, subject, "actor_id") !== undefined
            ? { actor_id: optionalString(file, line, subject, "actor_id") as string }
            : {}),
          ...(optionalString(file, line, subject, "subject") !== undefined
            ? { subject: optionalString(file, line, subject, "subject") as string }
            : {}),
        },
        mode,
        reason: requiredString(file, line, source, "reason"),
        ...(redactActor !== undefined ? { redact_actor_events: redactActor } : {}),
        expect,
        ...(note !== undefined ? { note } : {}),
      };
    }
    default:
      fail(file, line, "unknown_action", `unhandled action ${JSON.stringify(action)}`);
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Parse one JSONL fixture file.
 *
 * Every non-blank line is either the header or a body line, and every non-blank
 * line is accounted for: `seen` counts them and the function refuses to return
 * unless the parsed lines plus comments equal the total. A line that neither
 * parses nor is a comment is an error with its number attached.
 */
export function parseFixtureText(path: string, text: string): FixtureFile {
  const rawLines = text.split(/\r?\n/);
  let header: FixtureHeader | null = null;
  const body: FixtureBodyLine[] = [];
  const seenLineIds = new Map<string, number>();
  let nonBlank = 0;

  for (const [index, raw] of rawLines.entries()) {
    const lineNumber = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    nonBlank += 1;
    if (trimmed.startsWith("#")) continue; // comment

    if (!trimmed.startsWith("{")) {
      fail(
        path,
        lineNumber,
        "not_json",
        `expected a JSON object on this line; comment lines must start with \`#\`. Got: ${JSON.stringify(
          trimmed.slice(0, 60),
        )}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      fail(path, lineNumber, "not_json", `invalid JSON: ${(error as Error).message}`);
    }
    const object = asObject(path, lineNumber, parsed, "fixture line");

    if (header === null) {
      if (!("fixture_version" in object)) {
        fail(
          path,
          lineNumber,
          "missing_header",
          "the first non-comment line must be the header (fixture_version, dataset_version, fixture_id, suite, title, ground_truth)",
        );
      }
      header = parseHeader(path, lineNumber, object);
      continue;
    }

    if ("fixture_version" in object && !("action" in object)) {
      fail(path, lineNumber, "duplicate_header", "a second header line appeared; a fixture file has exactly one");
    }

    const bodyLine = parseBodyLine(path, lineNumber, object);
    const previous = seenLineIds.get(bodyLine.line_id);
    if (previous !== undefined) {
      fail(
        path,
        lineNumber,
        "duplicate_line_id",
        `line_id ${JSON.stringify(bodyLine.line_id)} was already used on line ${previous}; ` +
          "expectations reference line ids, so duplicates make a failure ambiguous",
      );
    }
    seenLineIds.set(bodyLine.line_id, lineNumber);
    body.push(bodyLine);
  }

  if (header === null) {
    fail(path, 1, "missing_header", "the file contains no header line");
  }
  if (nonBlank === 0) {
    fail(path, 1, "missing_header", "the file is empty");
  }
  if (body.length === 0) {
    fail(path, header.line, "missing_header", "the file has a header but no body lines");
  }
  // Cross-references: an expectation that names another line must name a line that
  // exists, otherwise a typo silently turns a chained assertion into a no-op.
  for (const entry of body) {
    for (const expectation of entry.expect) {
      if (expectation.type === "expect_reason" && expectation.line_id !== undefined) {
        if (!seenLineIds.has(expectation.line_id)) {
          fail(
            path,
            entry.line,
            "missing_field",
            `expect_reason references line_id ${JSON.stringify(expectation.line_id)}, which does not exist in this fixture`,
          );
        }
      }
    }
  }

  return { path, header, body };
}

export function parseFixtureFile(path: string): FixtureFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new FixtureParseError(path, 1, "io", `cannot read fixture: ${(error as Error).message}`);
  }
  return parseFixtureText(path, text);
}

// ---------------------------------------------------------------------------
// Conformance documents
// ---------------------------------------------------------------------------

function parseConformanceOutcome(file: string, line: number, value: unknown, what: string): ConformanceOutcome {
  const source = asObject(file, line, value, what);
  const decisions: ConformanceDecisionAssertion[] = [];
  if (source["decisions"] !== undefined) {
    const raw = field(file, line, source, "decisions");
    if (!Array.isArray(raw)) fail(file, line, "wrong_type", `${what}.decisions must be an array`);
    for (const [index, entry] of raw.entries()) {
      const item = asObject(file, line, entry, `${what}.decisions[${index}]`);
      const mustInclude = optionalStringArray(file, line, item, "must_include_reason_codes");
      const mustExclude = optionalStringArray(file, line, item, "must_exclude_reason_codes");
      if (mustInclude) checkReasonCodes(file, line, mustInclude, `${what}.decisions[${index}].must_include_reason_codes`);
      if (mustExclude) checkReasonCodes(file, line, mustExclude, `${what}.decisions[${index}].must_exclude_reason_codes`);
      decisions.push({
        line_id: requiredString(file, line, item, "line_id"),
        ...(optionalString(file, line, item, "outcome") !== undefined
          ? { outcome: optionalString(file, line, item, "outcome") as string }
          : {}),
        ...(mustInclude !== undefined ? { must_include_reason_codes: mustInclude } : {}),
        ...(mustExclude !== undefined ? { must_exclude_reason_codes: mustExclude } : {}),
      });
    }
  }
  const relations: ConformanceRelationAssertion[] = [];
  if (source["relations"] !== undefined) {
    const raw = field(file, line, source, "relations");
    if (!Array.isArray(raw)) fail(file, line, "wrong_type", `${what}.relations must be an array`);
    for (const [index, entry] of raw.entries()) {
      const item = asObject(file, line, entry, `${what}.relations[${index}]`);
      relations.push({
        from: requiredString(file, line, item, "from"),
        to: requiredString(file, line, item, "to"),
        rel: oneOf(file, line, requiredString(file, line, item, "rel"), RELATION_KINDS, "rel"),
      });
    }
  }
  const acceptedScopeRaw = optionalObject(file, line, source, "accepted_scope");
  const acceptedScope =
    acceptedScopeRaw === undefined
      ? undefined
      : {
          ...(optionalString(file, line, acceptedScopeRaw, "project") !== undefined
            ? { project: optionalString(file, line, acceptedScopeRaw, "project") as string }
            : {}),
          ...(optionalString(file, line, acceptedScopeRaw, "user") !== undefined
            ? { user: optionalString(file, line, acceptedScopeRaw, "user") as string }
            : {}),
          ...(optionalString(file, line, acceptedScopeRaw, "agent") !== undefined
            ? { agent: optionalString(file, line, acceptedScopeRaw, "agent") as string }
            : {}),
          ...(optionalString(file, line, acceptedScopeRaw, "session") !== undefined
            ? { session: optionalString(file, line, acceptedScopeRaw, "session") as string }
            : {}),
        };
  const counts: Record<string, number> = {};
  for (const key of [
    "accepted_claims",
    "superseded_claims",
    "revoked_claims",
    "claim_rows_retained",
    "contradicting_relations",
    "residual_matches",
    "ledger_rows_preserved",
  ]) {
    if (source[key] === undefined || source[key] === null) continue;
    const parsed = requiredNumber(file, line, source, key);
    if (!Number.isInteger(parsed) || parsed < 0) {
      fail(file, line, "wrong_type", `${what}.${key} must be a non-negative integer`);
    }
    counts[key] = parsed;
  }
  const residualStores = optionalStringArray(file, line, source, "residual_stores");
  return {
    ...(decisions.length > 0 ? { decisions } : {}),
    ...(relations.length > 0 ? { relations } : {}),
    ...(acceptedScope !== undefined ? { accepted_scope: acceptedScope } : {}),
    ...(residualStores !== undefined ? { residual_stores: residualStores } : {}),
    // Absent counts stay absent: the oracle distinguishes "asserted zero" from
    // "not asserted", and a default of 0 would silently turn one into the other.
    ...counts,
  } as ConformanceOutcome;
}

/**
 * Parse one conformance trace document.
 *
 * Conformance traces are single JSON objects rather than JSONL: a trace is a
 * document with a nested input sequence, and flattening it into lines would
 * destroy the only thing it is for — being readable end to end by a human
 * deciding whether the required outcome is right.
 */
export function parseConformanceDocument(path: string, text: string): ConformanceTrace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FixtureParseError(path, 1, "not_json", `invalid JSON: ${(error as Error).message}`);
  }
  const source = asObject(path, 1, parsed, "conformance document");
  const line = 1;
  const fixtureVersion = requiredString(path, line, source, "fixture_version");
  if (!SUPPORTED_FIXTURE_VERSIONS.includes(fixtureVersion)) {
    fail(path, line, "unsupported_version", `fixture_version ${fixtureVersion} is not supported`);
  }
  const groundTruth = oneOf(
    path,
    line,
    requiredString(path, line, source, "ground_truth"),
    GROUND_TRUTH_LEVELS,
    "ground_truth",
  );
  const inputsRaw = field(path, line, source, "inputs");
  if (!Array.isArray(inputsRaw)) fail(path, line, "wrong_type", "inputs must be an array");
  if (inputsRaw.length === 0) fail(path, line, "empty_expectation", "a conformance trace needs at least one input");
  const inputs = inputsRaw.map((entry) => parseBodyLine(path, line, entry));
  const trace: ConformanceTrace = {
    fixture_version: fixtureVersion,
    dataset_version: requiredString(path, line, source, "dataset_version"),
    suite: "conformance",
    trace_id: requiredString(path, line, source, "trace_id"),
    title: requiredString(path, line, source, "title"),
    adversary: requiredString(path, line, source, "adversary"),
    ground_truth: groundTruth,
    requires: stringArray(path, line, source, "requires", { minItems: 1 }),
    rationale: requiredString(path, line, source, "rationale"),
    inputs,
    required_outcome: parseConformanceOutcome(path, line, field(path, line, source, "required_outcome"), "required_outcome"),
    ...(source["unimplemented_outcome"] !== undefined
      ? {
          unimplemented_outcome: (() => {
            const raw = asObject(path, line, source["unimplemented_outcome"], "unimplemented_outcome");
            // `because` belongs to the unimplemented block, not to the trace: it
            // explains why this one requirement is not met, and reading it from the
            // trace root silently dropped every explanation while still parsing.
            const because = optionalString(path, line, raw, "because");
            return {
              ...parseConformanceOutcome(path, line, raw, "unimplemented_outcome"),
              ...(because !== undefined ? { because } : {}),
            };
          })(),
        }
      : {}),
    ...(source["notes"] !== undefined ? { notes: (source["notes"] ?? null) as string | null } : {}),
  };
  for (const entry of trace.inputs) {
    for (const expectation of entry.expect) {
      if (expectation.type === "expect_reason" && expectation.line_id !== undefined) {
        if (!trace.inputs.some((candidate) => candidate.line_id === expectation.line_id)) {
          fail(
            path,
            line,
            "missing_field",
            `expect_reason references line_id ${JSON.stringify(expectation.line_id)}, which is not an input of ${trace.trace_id}`,
          );
        }
      }
    }
  }
  return trace;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const FIXTURE_DIRS: readonly Suite[] = ["ledgerbench", "poisoning", "deletion"];

/**
 * The published index of the ten conformance traces.
 *
 * Constants are evaluated where they are declared, so this one lives above the
 * discovery function that reads it: a `const` declared after a function that runs
 * during module evaluation is a temporal-dead-zone error that only appears when the
 * function is called, which is the least convenient time to find it.
 */
const CONFORMANCE_INDEX_FILE_NAME = "traces.json";

export interface LoadOptions {
  /** Repository `fixtures/` directory. */
  readonly root: string;
  /** Restrict to one suite. */
  readonly suite?: Suite;
  /** Restrict to fixture ids matching this substring. */
  readonly filter?: string;
}

/**
 * Load every fixture under `root`, collecting parse failures rather than throwing.
 *
 * Collecting is the right behaviour for a test: a suite that stops at the first
 * malformed fixture hides the other nine, and the point of parsing every fixture
 * is to be able to say "all of them are well-formed" as a single assertion.
 */
export function loadFixtures(options: LoadOptions): FixtureLoadReport {
  const files: FixtureFile[] = [];
  const failures: { file: string; line: number; code: string; message: string }[] = [];
  const dirs = options.suite ? [options.suite] : FIXTURE_DIRS;

  for (const suite of dirs) {
    const dir = join(options.root, suite);
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const relativePath = relative(options.root, path);
      if (options.filter !== undefined && !relativePath.includes(options.filter)) continue;
      try {
        if (name.endsWith(".jsonl")) {
          files.push(parseFixtureFile(path));
        } else if (name.endsWith(".json") && name !== CONFORMANCE_INDEX_FILE_NAME) {
          // The individual trace documents are loaded so each trace has its own
          // file; the index would otherwise be parsed as an extra, malformed trace.
          const trace = parseConformanceDocument(path, readFileSync(path, "utf8"));
          files.push({
            path,
            header: {
              kind: "header",
              line: 1,
              fixture_version: trace.fixture_version,
              dataset_version: trace.dataset_version,
              fixture_id: `conformance/${trace.trace_id}`,
              suite: "conformance" as unknown as Suite,
              title: trace.title,
              ground_truth: trace.ground_truth,
            },
            body: trace.inputs,
            conformance: trace,
          });
        }
      } catch (error) {
        if (error instanceof FixtureParseError) {
          failures.push({ file: error.file, line: error.line, code: error.code, message: error.message });
        } else {
          failures.push({ file: path, line: 1, code: "io", message: (error as Error).message });
        }
      }
    }
  }

  return { root: options.root, files, failures };
}

/**
 * Every conformance trace under `fixtures/conformance`.
 *
 * `traces.json` is the published index of the same ten traces, not an eleventh
 * trace, so it is skipped by name. The index exists so a replay oracle can be
 * pointed at the whole set without globbing.
 */
export function loadConformanceTraces(root: string): { traces: ConformanceTrace[]; failures: FixtureLoadReport["failures"] } {
  const traces: ConformanceTrace[] = [];
  const failures: { file: string; line: number; code: string; message: string }[] = [];
  const dir = join(root, "conformance");
  const seen = new Set<string>();

  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      failures.push({ file: path, line: 1, code: "io", message: (error as Error).message });
      continue;
    }

    // Both arrangements are supported, and the file's own shape decides which it
    // is: a document with a `trace_id` is one trace, and a document with a
    // `traces` array is an index that names others. Deciding by filename would
    // mean a suite that renamed its index file silently loaded nothing — which is
    // exactly the failure this loader originally had, reporting ten missing traces
    // while ten valid trace files sat next to it.
    const isIndex =
      raw !== null &&
      typeof raw === "object" &&
      Array.isArray((raw as { traces?: unknown }).traces) &&
      !("trace_id" in (raw as object));

    if (isIndex) {
      for (const entry of (raw as { traces: unknown[] }).traces) {
        if (entry === null || typeof entry !== "object") {
          failures.push({
            file: path,
            line: 1,
            code: "malformed_index_entry",
            message: `${path}: an entry in the trace index is not an object`,
          });
          continue;
        }
        const candidate = entry as Record<string, unknown>;
        const fileRef = typeof candidate["file"] === "string" ? candidate["file"] : null;
        if (fileRef === null) {
          // An inline trace object is parsed directly so an index may embed its
          // traces as well as name them.
          try {
            const trace = parseConformanceDocument(path, JSON.stringify(entry));
            if (!seen.has(trace.trace_id)) {
              seen.add(trace.trace_id);
              traces.push(trace);
            }
          } catch (error) {
            const failure =
              error instanceof FixtureParseError
                ? { file: error.file, line: error.line, code: error.code, message: error.message }
                : { file: path, line: 1, code: "io", message: (error as Error).message };
            failures.push(failure);
          }
          continue;
        }
        const referenced = join(dir, fileRef);
        try {
          const trace = parseConformanceDocument(referenced, readFileSync(referenced, "utf8"));
          if (!seen.has(trace.trace_id)) {
            seen.add(trace.trace_id);
            traces.push(trace);
          }
        } catch (error) {
          const failure =
            error instanceof FixtureParseError
              ? { file: error.file, line: error.line, code: error.code, message: error.message }
              : { file: referenced, line: 1, code: "io", message: (error as Error).message };
          failures.push(failure);
        }
      }
      continue;
    }

    try {
      const trace = parseConformanceDocument(path, readFileSync(path, "utf8"));
      if (seen.has(trace.trace_id)) continue;
      seen.add(trace.trace_id);
      traces.push(trace);
    } catch (error) {
      const failure =
        error instanceof FixtureParseError
          ? { file: error.file, line: error.line, code: error.code, message: error.message }
          : { file: path, line: 1, code: "io", message: (error as Error).message };
      failures.push(failure);
    }
  }

  traces.sort((left, right) => left.trace_id.localeCompare(right.trace_id));
  return { traces, failures };
}

/** Decision outcomes, exported so a caller can assert it is reading the real vocabulary. */
export const DECISION_OUTCOME_VOCABULARY = DECISION_OUTCOMES;

/** Claim kinds, exported for the same reason. */
export const CLAIM_KIND_VOCABULARY: readonly string[] = CLAIM_KINDS;
