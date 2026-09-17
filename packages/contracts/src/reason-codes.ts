/**
 * Reason codes.
 *
 * Every decision records machine-readable reason codes, and the codes are a
 * closed set. This is not documentation tidiness: the review-burden metric, the
 * poisoning fixtures and the gate calibration loop all read these strings, so an
 * ad-hoc code is an unmeasured decision.
 */
export const REASON_CODES = {
  // ---- span and evidence integrity (deterministic, pre-model) -------------
  SPAN_RESOLVED: "span.resolved",
  SPAN_UNRESOLVABLE: "span.unresolvable",
  SPAN_DIGEST_MISMATCH: "span.digest_mismatch",
  SPAN_EVENT_REDACTED: "span.event_redacted",
  SPAN_OUT_OF_BOUNDS: "span.out_of_bounds",
  NO_SUPPORTING_EVIDENCE: "evidence.none",
  EVIDENCE_ROLE_MISSING: "evidence.role_missing",

  // ---- entailment --------------------------------------------------------
  ENTAILMENT_ENTAILED: "entailment.entailed",
  ENTAILMENT_NEUTRAL: "entailment.neutral",
  ENTAILMENT_CONTRADICTION: "entailment.contradiction",
  ENTAILMENT_UNAVAILABLE: "entailment.unavailable",
  ENTAILMENT_BELOW_THRESHOLD: "entailment.below_threshold",
  ENTAILMENT_COREFERENCE: "entailment.known_coreference_failure",
  ENTAILMENT_ENTITY_ATTRIBUTION: "entailment.known_entity_attribution_failure",

  // ---- authority ---------------------------------------------------------
  AUTHORITY_STRONG: "authority.strong",
  AUTHORITY_WEAK: "authority.inference_or_hearsay",
  AUTHORITY_MISMATCH_KIND: "authority.kind_mismatch",

  // ---- scope -------------------------------------------------------------
  SCOPE_WITHIN_EVENT: "scope.within_event_scope",
  SCOPE_BROADER_THAN_EVENT: "scope.broader_than_event_scope",
  SCOPE_OUTSIDE_EVENT: "scope.outside_event_scope",
  SCOPE_PURPOSE_BROADENED: "scope.purpose_broadened",
  SCOPE_NARROWED_TO_EVENT: "scope.narrowed_to_event",

  // ---- conflict ----------------------------------------------------------
  CONFLICT_NONE: "conflict.none",
  CONFLICT_CONTRADICTS_ACCEPTED: "conflict.contradicts_accepted",
  CONFLICT_DUPLICATE: "conflict.duplicates_accepted",
  CONFLICT_NARROWS: "conflict.narrows_accepted",
  CONFLICT_SUPERSEDES: "conflict.supersedes_accepted",
  CONFLICT_UNRESOLVED_TEMPORAL_OVERLAP: "conflict.unresolved_temporal_overlap",

  // ---- admission and safety ---------------------------------------------
  ADMISSION_INSTRUCTION_LIKE: "admission.instruction_like",
  ADMISSION_EXTERNAL_INSTRUCTION: "admission.external_instruction",
  ADMISSION_SENSITIVE: "admission.sensitive",
  KIND_REQUIRES_REVIEW: "kind.requires_review",
  KIND_PRIVILEGED: "kind.privileged",
  EXTRACTOR_DETERMINISTIC: "extractor.deterministic",
  EXTRACTOR_MODEL: "extractor.model",

  // ---- gate outcomes -----------------------------------------------------
  GATE_AUTO_ACCEPT_ELIGIBLE: "gate.auto_accept_eligible",
  GATE_QUARANTINED: "gate.quarantined",
  GATE_NEEDS_REVIEW: "gate.needs_review",

  // ---- retrieval and use policy -----------------------------------------
  USE_FRESH_AUTHORITATIVE: "use.fresh_authoritative",
  USE_ENTAILED_UNVERIFIED: "use.entailed_unverified",
  USE_STALE: "use.stale",
  USE_EXPIRED: "use.expired",
  USE_CONFLICTED: "use.conflicted",
  USE_WEAK_AUTHORITY: "use.weak_authority",
  USE_SCOPE_NARROWER_THAN_QUERY: "use.scope_narrower_than_query",
  USE_SENSITIVE_PURPOSE_MISMATCH: "use.sensitive_purpose_mismatch",
  USE_REVOKED: "use.revoked",

  // ---- action gate -------------------------------------------------------
  ACTION_ALLOWED: "action.allowed",
  ACTION_DENIED_CLAIM_NOT_USABLE: "action.denied_claim_not_usable",
  ACTION_DENIED_STALE_EVIDENCE: "action.denied_stale_evidence",
  ACTION_DENIED_SCOPE_UNREACHABLE: "action.denied_scope_unreachable",
  ACTION_DENIED_UNKNOWN_CLAIM: "action.denied_unknown_claim",
  ACTION_DENIED_RISK_EXCEEDS_USE: "action.denied_risk_exceeds_use",

  // ---- retention ---------------------------------------------------------
  RETENTION_MANIFEST_BUILT: "retention.manifest_built",
  RETENTION_RESIDUAL_MATCHES: "retention.residual_matches",
  RETENTION_VERIFIED: "retention.verified",
  RETENTION_LEDGER_PRESERVED: "retention.ledger_row_preserved",
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

export const REASON_CODE_VALUES: readonly string[] = Object.freeze(Object.values(REASON_CODES));

const REASON_CODE_SET = new Set<string>(REASON_CODE_VALUES);

export function isKnownReasonCode(code: string): boolean {
  return REASON_CODE_SET.has(code);
}

/**
 * Human-readable explanations, surfaced by /explain so an operator is never
 * required to read the source to understand a decision.
 */
export const REASON_CODE_HELP: Record<ReasonCode, string> = {
  [REASON_CODES.SPAN_RESOLVED]: "Every supporting span resolved against the stored payload and its digest matched.",
  [REASON_CODES.SPAN_UNRESOLVABLE]: "A supporting span could not be resolved; the payload is missing or the offsets are outside it.",
  [REASON_CODES.SPAN_DIGEST_MISMATCH]: "The bytes at the recorded offsets no longer hash to the recorded span digest.",
  [REASON_CODES.SPAN_EVENT_REDACTED]: "The originating event payload was erased under a retention policy, so the span text is gone.",
  [REASON_CODES.SPAN_OUT_OF_BOUNDS]: "Span offsets fall outside the event payload length.",
  [REASON_CODES.NO_SUPPORTING_EVIDENCE]: "The candidate cites no supporting span. A claim without evidence cannot be admitted.",
  [REASON_CODES.EVIDENCE_ROLE_MISSING]: "Evidence rows exist but none is marked as supporting.",
  [REASON_CODES.ENTAILMENT_ENTAILED]: "The proposition is entailed by the cited span under the configured model.",
  [REASON_CODES.ENTAILMENT_NEUTRAL]: "The span does not establish the proposition; it is neither supported nor contradicted.",
  [REASON_CODES.ENTAILMENT_CONTRADICTION]: "The span asserts the opposite of the proposition.",
  [REASON_CODES.ENTAILMENT_UNAVAILABLE]: "The entailment model was unavailable, so the candidate cannot be auto-accepted.",
  [REASON_CODES.ENTAILMENT_BELOW_THRESHOLD]: "Entailment scored below the configured acceptance threshold.",
  [REASON_CODES.ENTAILMENT_COREFERENCE]: "Known failure class: the claim's referent sits outside the span, typically in a previous sentence.",
  [REASON_CODES.ENTAILMENT_ENTITY_ATTRIBUTION]: "Known failure class: the span entails the proposition but is about a different entity.",
  [REASON_CODES.AUTHORITY_STRONG]: "Origin class is verified record, direct observation, or user self-report.",
  [REASON_CODES.AUTHORITY_WEAK]: "Origin class is inference or hearsay; such claims are never auto-accepted.",
  [REASON_CODES.AUTHORITY_MISMATCH_KIND]: "The declared authority class is inconsistent with the claim kind or origin.",
  [REASON_CODES.SCOPE_WITHIN_EVENT]: "The requested scope is contained by the scope of the evidence.",
  [REASON_CODES.SCOPE_BROADER_THAN_EVENT]: "The requested scope is wider than the scope of the evidence that supports it.",
  [REASON_CODES.SCOPE_OUTSIDE_EVENT]: "The requested scope is not contained by the evidence scope in any dimension.",
  [REASON_CODES.SCOPE_PURPOSE_BROADENED]: "The requested purpose set adds purposes the evidence was not admitted for.",
  [REASON_CODES.SCOPE_NARROWED_TO_EVENT]: "The claim was admitted at the evidence's scope rather than the broader scope requested.",
  [REASON_CODES.CONFLICT_NONE]: "No accepted claim in scope duplicates, narrows, contradicts or supersedes this one.",
  [REASON_CODES.CONFLICT_CONTRADICTS_ACCEPTED]: "An accepted claim in the same scope asserts the opposite.",
  [REASON_CODES.CONFLICT_DUPLICATE]: "An accepted claim in the same scope already states this proposition.",
  [REASON_CODES.CONFLICT_NARROWS]: "An accepted claim in the same scope states a narrower version of this proposition.",
  [REASON_CODES.CONFLICT_SUPERSEDES]: "This candidate supersedes an accepted claim in the same scope.",
  [REASON_CODES.CONFLICT_UNRESOLVED_TEMPORAL_OVERLAP]: "An accepted claim overlaps in validity without a resolved relation.",
  [REASON_CODES.ADMISSION_INSTRUCTION_LIKE]: "The payload contains instruction-like material.",
  [REASON_CODES.ADMISSION_EXTERNAL_INSTRUCTION]: "Instruction-like content arrived from an external origin and is treated as data only.",
  [REASON_CODES.ADMISSION_SENSITIVE]: "The payload is labelled high sensitivity.",
  [REASON_CODES.KIND_REQUIRES_REVIEW]: "The claim kind is identity, permission, money, safety or executable procedure, which requires a human.",
  [REASON_CODES.KIND_PRIVILEGED]: "The claim kind can grant capability or change behaviour and is therefore quarantined.",
  [REASON_CODES.EXTRACTOR_DETERMINISTIC]: "Produced by a deterministic extractor with no model call.",
  [REASON_CODES.EXTRACTOR_MODEL]: "Produced by a model extractor; the model and prompt versions are recorded.",
  [REASON_CODES.GATE_AUTO_ACCEPT_ELIGIBLE]: "Every auto-accept precondition held.",
  [REASON_CODES.GATE_QUARANTINED]: "The candidate was quarantined pending human review.",
  [REASON_CODES.GATE_NEEDS_REVIEW]: "No rule matched decisively; a human must decide.",
  [REASON_CODES.USE_FRESH_AUTHORITATIVE]: "Accepted, in scope, fresh, unconflicted and strongly evidenced.",
  [REASON_CODES.USE_ENTAILED_UNVERIFIED]: "Evidence is entailed but the authority class or conflict state warrants verification before consequential use.",
  [REASON_CODES.USE_STALE]: "The claim is older than the staleness horizon for its kind.",
  [REASON_CODES.USE_EXPIRED]: "The claim's expiry has passed.",
  [REASON_CODES.USE_CONFLICTED]: "An unresolved contradiction exists for this claim.",
  [REASON_CODES.USE_WEAK_AUTHORITY]: "Authority class is inference or hearsay.",
  [REASON_CODES.USE_SCOPE_NARROWER_THAN_QUERY]: "The claim is valid only in a narrower scope than the action.",
  [REASON_CODES.USE_SENSITIVE_PURPOSE_MISMATCH]: "The claim is sensitive and the declared purpose does not match its admission purpose.",
  [REASON_CODES.USE_REVOKED]: "The claim was revoked and must never be used.",
  [REASON_CODES.ACTION_ALLOWED]: "Every referenced claim carries an allowed use decision with current evidence.",
  [REASON_CODES.ACTION_DENIED_CLAIM_NOT_USABLE]: "At least one referenced claim does not carry an allowed use decision.",
  [REASON_CODES.ACTION_DENIED_STALE_EVIDENCE]: "At least one referenced claim's evidence is no longer current for the action's risk level.",
  [REASON_CODES.ACTION_DENIED_SCOPE_UNREACHABLE]: "The acting principal cannot reach at least one referenced claim.",
  [REASON_CODES.ACTION_DENIED_UNKNOWN_CLAIM]: "At least one referenced claim id does not exist or is not visible.",
  [REASON_CODES.ACTION_DENIED_RISK_EXCEEDS_USE]: "The action's risk level is higher than the use decision permits.",
  [REASON_CODES.RETENTION_MANIFEST_BUILT]: "The deletion manifest was built and every touched store recorded.",
  [REASON_CODES.RETENTION_RESIDUAL_MATCHES]: "A residual-match scan found surviving copies.",
  [REASON_CODES.RETENTION_VERIFIED]: "Residual-match scan returned zero across every declared store.",
  [REASON_CODES.RETENTION_LEDGER_PRESERVED]: "The ledger row survives redaction so that the system can still testify the event existed.",
};
