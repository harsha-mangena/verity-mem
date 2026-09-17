/**
 * The LedgerBench fixture format, as types.
 *
 * The format has one job: make a claim about what the system must do, in a form a
 * machine can hold the system to. Three consequences follow, and they are the
 * reason this file is longer than the schema it describes:
 *
 *  1. An event line is a real `EventAppendRequest`. The fixture format wraps it,
 *     it does not restate it, so a schema change breaks fixtures loudly instead of
 *     letting them drift into testing a format that no longer exists.
 *  2. Expectations are attached to the line that should satisfy them, so a failure
 *     names one line rather than "the suite".
 *  3. `ground_truth` is declared per fixture, because the difference between a
 *     mechanically checkable assertion and a judgement call is the difference
 *     between evidence and opinion, and a benchmark that blurs them is marketing.
 */
import type { ClaimKind, ClaimStatus, EventAppendRequest, RelationKind } from "@veritymem/contracts";

/** Bumped when the line grammar changes in a way older readers cannot parse. */
export const SUPPORTED_FIXTURE_VERSIONS: readonly string[] = ["1.0.0"];

export const SUITES = ["ledgerbench", "poisoning", "deletion"] as const;
export type Suite = (typeof SUITES)[number];

/**
 * `by_construction` — the expected outcome follows from the inputs by a rule that
 *   can be re-derived by reading the fixture, so a disagreement is a bug report.
 * `judgement` — the expected outcome encodes a decision about correct behaviour
 *   that a reasonable implementer could take the other way. These are the fixtures
 *   most likely to be wrong, and the runner reports them separately.
 */
export const GROUND_TRUTH_LEVELS = ["by_construction", "judgement"] as const;
export type GroundTruth = (typeof GROUND_TRUTH_LEVELS)[number];

export const ACTIONS = ["append_event", "create_grant", "resolve_claim", "erase_subject"] as const;
export type FixtureAction = (typeof ACTIONS)[number];

export const RESOLVE_OUTCOMES = ["revoke", "supersede"] as const;
export type ResolveOutcome = (typeof RESOLVE_OUTCOMES)[number];

export const ERASE_MODES = ["erase", "redact", "export_then_erase"] as const;
export type EraseMode = (typeof ERASE_MODES)[number];

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

/** How a claim is identified in an expectation. Absent fields are wildcards. */
export interface ClaimMatch {
  readonly subject?: string;
  readonly predicate?: string;
  readonly object?: unknown;
  readonly kind?: ClaimKind;
  readonly status?: ClaimStatus;
  /** Compare in a tenant other than the fixture's own. Used by the contamination fixture. */
  readonly tenant?: string;
}

export interface ExpectClaim extends ClaimMatch {
  readonly type: "expect_claim";
  readonly scope?: {
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
    readonly purpose?: readonly string[];
  };
}

export interface ExpectNoClaim extends ClaimMatch {
  readonly type: "expect_no_claim";
  /**
   * Restrict the assertion to one scope.
   *
   * Without it, "no claim" means "nothing is currently believed for this match",
   * which is what a scope-broadening fixture needs. With it, the assertion becomes
   * "nothing was admitted into *this* scope" — the contamination question.
   */
  readonly scope?: {
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
    readonly purpose?: readonly string[];
  };
}

export interface ExpectQuarantined {
  readonly type: "expect_quarantined";
  readonly kind?: ClaimKind;
}

export interface ExpectNeedsReview {
  readonly type: "expect_needs_review";
  readonly kind?: ClaimKind;
}

export interface ExpectScopeNarrowed {
  readonly type: "expect_scope_narrowed";
  readonly kind?: ClaimKind;
}

/**
 * A relation must exist against an earlier accepted claim.
 *
 * `kind` names the relation the verifier should have found. `expect_conflict`
 * deliberately requires the *detection*, not the persisted row: the current gate
 * records a contradicting claim in the decision detail but only writes
 * `claim_relations` rows for duplicates and supersedes, and a benchmark that
 * asserted the row would report a failure the metric cannot explain. The
 * `conflict.relation_persisted_rate` metric reports the difference separately.
 */
export interface ExpectConflict {
  readonly type: "expect_conflict";
  readonly kind: RelationKind;
  readonly subject?: string;
  readonly predicate?: string;
  readonly object?: unknown;
  readonly against_subject?: string;
  readonly against_predicate?: string;
  readonly against_object?: unknown;
}

/**
 * The claim was withdrawn. Distinct from `expect_superseded`: revocation means the
 * claim must not be used, supersession means a newer claim replaced it. A matcher
 * that accepted either for both would let a system that never revokes pass a
 * revocation fixture.
 */
export interface ExpectRevoked extends ClaimMatch {
  readonly type: "expect_revoked";
}

/** The claim was replaced by a newer one and is history, not current belief. */
export interface ExpectSuperseded extends ClaimMatch {
  readonly type: "expect_superseded";
}

/**
 * The relation must exist as a `claim_relations` row, not only in the decision
 * detail.
 *
 * Split out from `expect_conflict` deliberately. `expect_conflict` asserts the
 * *detection*, which is what the conflict metric measures and what the gate
 * produces today. Persisting the row is a separate promise the data model makes,
 * and it is only kept for `duplicates` and `supersedes`. Folding the two together
 * would make a correct detection report as a failure with no way to tell the two
 * apart; keeping them apart lets the stage metric count the gap explicitly.
 */
export interface ExpectRelationPersisted {
  readonly type: "expect_relation_persisted";
  readonly kind: RelationKind;
  readonly subject?: string;
  readonly predicate?: string;
  readonly object?: unknown;
  readonly against_subject?: string;
  readonly against_predicate?: string;
  readonly against_object?: unknown;
}

export interface ExpectMissing {
  readonly type: "expect_missing";
  readonly query: string;
  /** Substring the packet's `missing` entry must contain, case-insensitive. */
  readonly contains?: string;
}

export interface ExpectReason {
  readonly type: "expect_reason";
  readonly must_include?: readonly string[];
  readonly must_exclude?: readonly string[];
  /** Which line's decision to inspect. Defaults to the line the expectation sits on. */
  readonly line_id?: string;
}

export interface ExpectGrant {
  readonly type: "expect_grant";
  readonly subject: string;
  readonly expires_at?: string;
  readonly expired?: boolean;
}

export interface ExpectDeleted {
  readonly type: "expect_deleted";
  readonly stores: readonly string[];
  readonly residual_matches: number;
  readonly status: string;
}

export interface ExpectResidualScan {
  readonly type: "expect_residual_scan";
  readonly stores: Readonly<Record<string, number>>;
  readonly ledger_rows_preserved?: number;
}

export interface ExpectUnverifiableClaim extends ClaimMatch {
  readonly type: "expect_unverifiable_claim";
  readonly reason_codes?: readonly string[];
}

export type Expectation =
  | ExpectClaim
  | ExpectNoClaim
  | ExpectQuarantined
  | ExpectNeedsReview
  | ExpectScopeNarrowed
  | ExpectConflict
  | ExpectRelationPersisted
  | ExpectRevoked
  | ExpectSuperseded
  | ExpectMissing
  | ExpectReason
  | ExpectGrant
  | ExpectDeleted
  | ExpectResidualScan
  | ExpectUnverifiableClaim;

export const EXPECTATION_TYPES: readonly Expectation["type"][] = [
  "expect_claim",
  "expect_no_claim",
  "expect_quarantined",
  "expect_needs_review",
  "expect_scope_narrowed",
  "expect_conflict",
  "expect_relation_persisted",
  "expect_revoked",
  "expect_superseded",
  "expect_missing",
  "expect_reason",
  "expect_grant",
  "expect_deleted",
  "expect_residual_scan",
  "expect_unverifiable_claim",
];

/**
 * Expectations the current build cannot evaluate at all.
 *
 * Listed explicitly so `parse.ts` accepts them and `run.ts` refuses to pass them:
 * a parsed expectation that silently reports success is exactly the failure mode
 * this benchmark exists to prevent. Each entry names the stage that must exist
 * before the expectation can become a real assertion.
 */
export const UNIMPLEMENTED_EXPECTATIONS: Readonly<Record<string, string>> = {
  expect_missing: "retrieval.packet — no MemoryPacket composer exists in v0.1, so 'missing' cannot be produced",
};

// ---------------------------------------------------------------------------
// Candidate proposals
// ---------------------------------------------------------------------------

/**
 * A candidate as the fixture proposes it.
 *
 * Mirrors `CandidateProposalSchema`, except a span may be written as an exact
 * `quote` instead of byte offsets. Offsets are still accepted and are the only
 * form the parser trusts verbatim; a quote is resolved against the event content
 * by the runner, and a quote that does not appear is a fixture error, never a
 * silently empty span.
 */
export interface FixtureSpan {
  readonly start?: number;
  readonly end?: number;
  readonly quote?: string;
  readonly role?: "supports" | "refutes";
  readonly selector?: string;
  /** Which occurrence of `quote` to use, 0-based. Defaults to the first. */
  readonly occurrence?: number;
}

export interface FixtureCandidate {
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly predicate: string;
  readonly object: unknown;
  readonly spans: readonly FixtureSpan[];
  readonly authority?: string;
  readonly confidence?: number;
  readonly requested_scope?: {
    readonly tenant?: string;
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
    readonly purpose?: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export interface FixtureHeader {
  readonly kind: "header";
  readonly fixture_version: string;
  readonly dataset_version: string;
  readonly fixture_id: string;
  readonly suite: Suite;
  readonly title: string;
  readonly ground_truth: GroundTruth;
  readonly notes?: string;
  /** 1-based line number in the source file. */
  readonly line: number;
}

export interface FixtureAppendEvent {
  readonly kind: "append_event";
  readonly line: number;
  readonly line_id: string;
  readonly event: EventAppendRequest;
  readonly candidate?: FixtureCandidate;
  readonly expect: readonly Expectation[];
  readonly note?: string;
}

export interface FixtureCreateGrant {
  readonly kind: "create_grant";
  readonly line: number;
  readonly line_id: string;
  readonly grant: {
    readonly subject: string;
    readonly resource_pattern: {
      readonly tenant: string;
      readonly project?: string;
      readonly user?: string;
      readonly agent?: string;
      readonly session?: string;
    };
    readonly actions: readonly string[];
    readonly purpose: readonly string[];
    readonly expires_at?: string;
  };
  readonly expect: readonly Expectation[];
  readonly note?: string;
}

export interface FixtureResolveClaim {
  readonly kind: "resolve_claim";
  readonly line: number;
  readonly line_id: string;
  readonly target: ClaimMatch;
  readonly outcome: ResolveOutcome;
  readonly reason: string;
  readonly reason_codes: readonly string[];
  readonly expect: readonly Expectation[];
  readonly note?: string;
}

export interface FixtureEraseSubject {
  readonly kind: "erase_subject";
  readonly line: number;
  readonly line_id: string;
  readonly subject_or_scope: {
    readonly tenant?: string;
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
    readonly actor_id?: string;
    readonly subject?: string;
  };
  readonly mode: EraseMode;
  readonly reason: string;
  /**
   * Redaction normally follows the actor: every event whose `actor_id` matches the
   * subject. `subject_or_scope` alone cannot express "the events by this actor",
   * and the whole point of the fixture is that the same person's events go.
   */
  readonly redact_actor_events?: boolean;
  readonly expect: readonly Expectation[];
  readonly note?: string;
}

export type FixtureBodyLine =
  | FixtureAppendEvent
  | FixtureCreateGrant
  | FixtureResolveClaim
  | FixtureEraseSubject;

export interface FixtureFile {
  readonly path: string;
  readonly header: FixtureHeader;
  readonly body: readonly FixtureBodyLine[];
  /** True when the file also carries a conformance document (JSON, not JSONL). */
  readonly conformance?: ConformanceTrace;
}

// ---------------------------------------------------------------------------
// Conformance traces
// ---------------------------------------------------------------------------

/**
 * The Phase 0 conformance artefact: ten end-to-end adversarial traces, each with
 * a stable id, a plain-English title, the input sequence and the required outcome.
 *
 * `required_outcome` is what the replay oracle can hold today. `unimplemented_outcome`
 * is the part of the trace the specification demands that the current build cannot
 * yet produce; it is recorded rather than dropped, because a trace that quietly
 * forgets half its requirement is how a conformance suite becomes decoration.
 */
export interface ConformanceTrace {
  readonly fixture_version: string;
  readonly dataset_version: string;
  readonly suite: "conformance";
  readonly trace_id: string;
  readonly title: string;
  readonly adversary: string;
  readonly ground_truth: GroundTruth;
  readonly notes?: string | null;
  readonly requires: readonly string[];
  readonly rationale: string;
  readonly inputs: readonly FixtureBodyLine[];
  readonly required_outcome: ConformanceOutcome;
  readonly unimplemented_outcome?: ConformanceOutcome & { readonly because?: string };
}

export interface ConformanceDecisionAssertion {
  readonly line_id: string;
  readonly outcome?: string;
  readonly must_include_reason_codes?: readonly string[];
  readonly must_exclude_reason_codes?: readonly string[];
}

export interface ConformanceRelationAssertion {
  readonly from: string;
  readonly to: string;
  readonly rel: RelationKind;
}

export interface ConformanceOutcome {
  readonly decisions?: readonly ConformanceDecisionAssertion[];
  /** Claims that are currently believed: `valid_to IS NULL AND status = 'accepted'`. */
  readonly accepted_claims?: number;
  readonly superseded_claims?: number;
  readonly revoked_claims?: number;
  readonly claim_rows_retained?: number;
  readonly relations?: readonly ConformanceRelationAssertion[];
  readonly contradicting_relations?: number;
  readonly accepted_scope?: {
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
  };
  readonly residual_matches?: number;
  readonly residual_stores?: readonly string[];
  readonly ledger_rows_preserved?: number;
}

/** A fixture file that failed to parse, with the file and line that failed. */
export interface FixtureParseFailure {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly message: string;
}

export interface FixtureLoadReport {
  readonly root: string;
  readonly files: readonly FixtureFile[];
  readonly failures: readonly FixtureParseFailure[];
}
