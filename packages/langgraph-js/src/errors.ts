/**
 * The refusals this adapter is allowed to make.
 *
 * Every error here exists because the alternative was a silent success. An
 * adapter that quietly widens a scope, quietly accepts an agent's conclusion, or
 * quietly reports a deletion it did not perform is worse than a missing adapter:
 * it produces ungated writes and unaudited reads under the project's name.
 *
 * These classes are deliberately framework-free. The LangGraph nodes are the
 * convenient entry point, not the only one: an application with no graph at all
 * calls `beforeAction` directly, and the failures it must handle cannot depend on
 * a peer package being installed.
 */

/** Why a namespace could not be read as explicit scope dimensions. */
export type NamespaceMappingCode =
  | "empty_namespace"
  | "opaque_segment"
  | "mixed_encoding"
  | "positional_length_mismatch"
  | "duplicate_dimension"
  | "missing_dimension"
  | "unbound_scope"
  | "empty_value"
  | "concatenated_value"
  | "peer_label_invalid";

/**
 * A namespace is not a string; it is a tuple of named scope dimensions.
 *
 * Thrown rather than repaired. The failure mode this prevents is the one the
 * specification names outright: concatenating tenant, project and purpose into one
 * opaque key, after which a purpose boundary can be crossed by a prefix match and
 * a tenant boundary is a substring. Falling back to a string key on a namespace we
 * cannot parse would reintroduce exactly that, so the adapter refuses instead.
 */
export class NamespaceMappingError extends Error {
  readonly code: NamespaceMappingCode;
  readonly namespace: readonly string[];

  constructor(code: NamespaceMappingCode, namespace: readonly string[], message: string) {
    super(message);
    this.name = "NamespaceMappingError";
    this.code = code;
    this.namespace = [...namespace];
  }
}

/**
 * The action gate said no.
 *
 * Thrown, not returned as a flag, because the specification is explicit that a
 * `verify` or `deny` verdict does not bind a model: an unattended agent ignores a
 * soft flag and takes the side effect anyway. The only representation of "denied"
 * that an unattended caller cannot ignore is an exception that unwinds the graph
 * before the side effect happens.
 */
export class ActionDeniedError extends Error {
  /** The action that was refused, as the caller named it. */
  readonly action: string;
  readonly action_risk: string;
  /** Every claim the caller said the action depended on. */
  readonly claim_ids: readonly string[];
  /** The subset of those claims that blocked the action, in the order requested. */
  readonly blocking_claim_ids: readonly string[];
  /** Machine-readable codes, from the closed `REASON_CODES` set. */
  readonly reason_codes: readonly string[];
  readonly decision: string;
  readonly policy_version: string;
  /** The raw verdict, so a caller can log or re-render the refusal without a second call. */
  readonly verdict: unknown;

  constructor(input: {
    readonly action: string;
    readonly action_risk: string;
    readonly claim_ids: readonly string[];
    readonly blocking_claim_ids: readonly string[];
    readonly reason_codes: readonly string[];
    readonly decision: string;
    readonly policy_version: string;
    readonly verdict: unknown;
  }) {
    const blocked = input.blocking_claim_ids.length > 0 ? input.blocking_claim_ids.join(", ") : "none reported";
    super(
      `action "${input.action}" denied at risk ${input.action_risk}: ` +
        `blocking claims [${blocked}] reason codes [${input.reason_codes.join(", ")}]`,
    );
    this.name = "ActionDeniedError";
    this.action = input.action;
    this.action_risk = input.action_risk;
    this.claim_ids = [...input.claim_ids];
    this.blocking_claim_ids = [...input.blocking_claim_ids];
    this.reason_codes = [...input.reason_codes];
    this.decision = input.decision;
    this.policy_version = input.policy_version;
    this.verdict = input.verdict;
  }
}

/**
 * A read or write was configured in a way that would have produced a meaningless
 * authorization check.
 *
 * The concrete cases: an action gate call with no referenced claims (it would
 * verify nothing and always allow), a query with no purpose (purpose is a hard
 * boundary — an empty one means unreachable, not unrestricted), and a read whose
 * declared purpose is not one the scope was admitted for.
 */
export class ScopeViolationError extends Error {
  readonly code: "empty_purpose" | "purpose_not_in_scope" | "ambiguous_purpose" | "no_claims" | "no_bound_dimension";
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: ScopeViolationError["code"],
    message: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ScopeViolationError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The store was asked to do something a claim-backed store cannot honestly do.
 *
 * Deletion, enumeration and reads by proposal key are the three. Each has a real
 * answer elsewhere in VerityMem (a retention job with a residual scan, an
 * authorized query, a claim id), and each is a place where a plausible-looking
 * implementation would quietly lie.
 */
export class StoreOperationRefusedError extends Error {
  readonly code: "delete" | "enumerate" | "resolve_proposal_key" | "search_without_query" | "index_config";
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: StoreOperationRefusedError["code"],
    message: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "StoreOperationRefusedError";
    this.code = code;
    this.detail = detail;
  }
}

/** A non-2xx answer, or no answer at all (`status === 0`). */
export class VerityApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(input: {
    readonly status: number;
    readonly method: string;
    readonly path: string;
    readonly message: string;
    readonly body?: unknown;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "VerityApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

/**
 * Whether an error means "you cannot see this claim".
 *
 * `404` and `403` are collapsed on purpose, because the server collapses them:
 * distinguishing "does not exist" from "not visible" turns any read into an
 * existence oracle for claims the caller was never authorized to see. Anything
 * else — a 500, a timeout, a malformed body — must *not* be read as "absent",
 * which is why this is a narrow predicate rather than a falsy check.
 */
export function isClaimUnreachable(error: unknown): boolean {
  if (error instanceof VerityApiError) return error.status === 403 || error.status === 404;
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}
