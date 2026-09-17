/**
 * Policy is versioned, and the version string is recorded on every decision.
 *
 * A policy change is therefore a recorded event, not a silent behavioural shift:
 * /v1/replay can re-evaluate an old ledger under the old policy and get the old
 * answer back, which is the only way "why did the system believe this in March?"
 * has a real answer.
 */

/**
 * Claim kinds that can never be auto-accepted, whatever their evidence says.
 * These are the kinds where a wrong belief grants capability or changes
 * behaviour: identity, permission, money, safety, executable procedure.
 */
export const QUARANTINE_KINDS = ["procedure", "permission"] as const;

/** Kinds where a contradiction is materially dangerous and staleness is costly. */
export const HIGH_IMPACT_KINDS = [
  "procedure",
  "permission",
  "decision",
  "user_self_report",
] as const;

/** Authority classes strong enough to auto-accept when everything else holds. */
export const AUTO_ACCEPT_AUTHORITIES = [
  "verified_record",
  "observation",
  "user_self_report",
] as const;

/**
 * Staleness horizons in days, per claim kind. Beyond the horizon the claim is
 * still returned but its use decision degrades to `verify`: retrievable is not
 * the same as actionable.
 */
export const STALENESS_HORIZON_DAYS: Record<string, number> = {
  observation: 30,
  user_self_report: 365,
  preference: 365,
  event: 90,
  decision: 90,
  plan: 30,
  hypothesis: 14,
  procedure: 180,
  permission: 30,
  derived_summary: 30,
};

export const DEFAULT_STALENESS_HORIZON_DAYS = 30;

/**
 * Gate thresholds. `entailmentFloor` is the score below which an entailment
 * verdict is not trusted for auto-acceptance. It is deliberately conservative:
 * the cost of a false accept is a durable wrong belief, the cost of a false
 * reject is a review item.
 */
export interface GateThresholds {
  readonly entailmentFloor: number;
  /** Fraction of writes permitted to require human review before the gate is called miscalibrated. */
  readonly reviewBurdenCeiling: number;
  /** Minimum token overlap for the deterministic lexical entailment stand-in to call `entailed`. */
  readonly lexicalEntailmentFloor: number;
}

export const GATE_THRESHOLDS: GateThresholds = {
  entailmentFloor: 0.5,
  reviewBurdenCeiling: 0.02,
  lexicalEntailmentFloor: 0.6,
};

export interface CommitPolicy {
  readonly version: string;
  readonly quarantineKinds: readonly string[];
  readonly autoAcceptAuthorities: readonly string[];
  readonly stalenessHorizonDays: Readonly<Record<string, number>>;
  readonly thresholds: GateThresholds;
}

/**
 * v3 baseline. The version string appears verbatim in `decisions.policy_version`
 * and in every packet, so bumping it without recording the reason is a bug.
 */
export const DEFAULT_COMMIT_POLICY: CommitPolicy = {
  version: "commit-v3",
  quarantineKinds: QUARANTINE_KINDS,
  autoAcceptAuthorities: AUTO_ACCEPT_AUTHORITIES,
  stalenessHorizonDays: STALENESS_HORIZON_DAYS,
  thresholds: GATE_THRESHOLDS,
};

/** The read-side counterpart of the commit policy. Recorded per packet. */
export const DEFAULT_USE_POLICY_VERSION = "use-v2";

/** The action-gate policy. Separate version because it gates consequences, not beliefs. */
export const DEFAULT_ACTION_POLICY_VERSION = "action-v1";

/**
 * Action risk to permitted use decisions. A medium-risk action may proceed on
 * `use`; a high-risk action additionally refuses `verify`, because "verify
 * first" is precisely the instruction an unattended agent will ignore.
 */
export const RISK_TO_ALLOWED_USE: Record<string, readonly string[]> = {
  low: ["use", "verify", "clarify"],
  medium: ["use"],
  high: ["use"],
};

/**
 * Maximum evidence age, in days, permitted per action risk. Beyond this the
 * action gate refuses regardless of the use decision, because the evidence that
 * justified the claim is no longer current for a consequential step.
 */
export const RISK_TO_MAX_EVIDENCE_AGE_DAYS: Record<string, number> = {
  low: 3650,
  medium: 365,
  high: 90,
};

export function stalenessHorizonFor(kind: string): number {
  return STALENESS_HORIZON_DAYS[kind] ?? DEFAULT_STALENESS_HORIZON_DAYS;
}
