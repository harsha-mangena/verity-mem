/**
 * Policy documents.
 *
 * The policy package exists so that the *rules* are data with versions, and the
 * *engine* that applies them is code. When the rules change, the version string
 * recorded on every decision changes with them, which is what makes an old
 * decision reproducible under `/v1/replay`.
 */
export {
  AUTO_ACCEPT_AUTHORITIES,
  DEFAULT_ACTION_POLICY_VERSION,
  DEFAULT_COMMIT_POLICY,
  DEFAULT_USE_POLICY_VERSION,
  GATE_THRESHOLDS,
  HIGH_IMPACT_KINDS,
  QUARANTINE_KINDS,
  RISK_TO_ALLOWED_USE,
  RISK_TO_MAX_EVIDENCE_AGE_DAYS,
  STALENESS_HORIZON_DAYS,
  stalenessHorizonFor,
  type CommitPolicy,
  type GateThresholds,
} from "@veritymem/contracts";
