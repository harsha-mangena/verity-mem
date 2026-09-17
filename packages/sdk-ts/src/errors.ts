/**
 * The one error type every SDK call can throw.
 *
 * It exists because the server has two failure modes that must never be
 * conflated: a *denied* action (the request succeeded, the answer is "no") and a
 * *failed* request (there is no answer). Collapsing either into `null` or into a
 * truthy/falsy boolean is how a caller ends up treating "the gate refused this"
 * as "the network hiccuped", or worse, retrying a denial until it succeeds.
 *
 * `code` is the server's machine-readable reason, `status` is the HTTP status.
 * Both are preserved verbatim; neither is normalized away.
 */

/**
 * Payload of the server's structured error body.
 *
 * Mirrors the Fastify-style envelope. `packages/contracts` does not freeze an
 * error schema, so this shape is read defensively at runtime and is the one
 * response shape in the SDK that is not contract-typed: an error body is
 * produced by the framework and the auth layer before any route schema applies.
 */
export interface VerityMemErrorBody {
  error?: string;
  code?: string;
  message?: string;
  status?: number;
  details?: unknown;
  [key: string]: unknown;
}

/** HTTP statuses the SDK gives a name to, because callers branch on them. */
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
} as const;

export interface VerityMemErrorInit {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  /** Machine-readable code from the server, or a synthesized client-side code. */
  readonly code: string;
  readonly message: string;
  /** Request path, so a log line identifies the failing route without a stack walk. */
  readonly path: string;
  /** Server-supplied detail. Kept `unknown` on purpose: it is diagnostic, not API. */
  readonly details?: unknown;
  readonly body?: unknown;
  /** Transport-level cause, when the failure was not an HTTP response at all. */
  readonly cause?: unknown;
}

/**
 * A non-2xx response, or a transport failure, from a VerityMem endpoint.
 *
 * Thrown rather than returned so that a caller cannot silently ignore a denial:
 * an ignored `null` return is a program that continues as if the write landed.
 */
export class VerityMemError extends Error {
  /** HTTP status. `0` means the request never produced a response. */
  readonly status: number;
  /** Server reason code, e.g. `authz.denied`, or a client code such as `network_error`. */
  readonly code: string;
  /** Request path that failed. */
  readonly path: string;
  readonly details: unknown;
  /** Raw parsed response body when one was available. */
  readonly body: unknown;

  constructor(init: VerityMemErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "VerityMemError";
    this.status = init.status;
    this.code = init.code;
    this.path = init.path;
    this.details = init.details;
    this.body = init.body;
  }

  /** True when the caller is authenticated but not permitted: a decision, not a fault. */
  get isDenial(): boolean {
    return this.status === HTTP_STATUS.FORBIDDEN || this.status === HTTP_STATUS.UNAUTHORIZED;
  }

  /** True when the request never produced an HTTP response and a retry may be meaningful. */
  get isTransportFailure(): boolean {
    return this.status === 0;
  }
}

/** Narrowing helper, so callers do not need `instanceof` across module copies. */
export function isVerityMemError(value: unknown): value is VerityMemError {
  return value instanceof VerityMemError;
}
