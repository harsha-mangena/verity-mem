/**
 * One error shape for the whole API.
 *
 * The reason this is a module rather than a few `reply.code(400).send(...)` calls
 * is that an error response is part of the contract: a client's retry logic keys
 * on `error.code`, and a code that appears in one route and not another is
 * untestable. Every handler throws `ApiError`; the Fastify error handler is the
 * single place that turns one into a response body.
 *
 * Two prohibitions are enforced here rather than left to reviewers:
 *
 *  1. A validation failure never echoes the submitted value. Fastify's own
 *     validation messages embed the offending data, which means a body naming
 *     another tenant could be reflected back in an error message. Only the
 *     instance path and the failed keyword travel.
 *  2. A database error never travels as text. Postgres constraint violations
 *     include the SQL fragment and sometimes the row's values; that is a schema
 *     disclosure and occasionally a cross-scope one. The code is logged, the
 *     message is generic.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LedgerError } from "@veritymem/ledger";

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * Codes are a closed set for the same reason reason codes are: a caller that
 * branches on `error.code` must not have to handle an unbounded vocabulary.
 */
export const API_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "audience_mismatch",
  "profile_insufficient",
  "validation_failed",
  "not_found",
  "conflict",
  "tenant_mismatch",
  "precondition_failed",
  "rate_limited",
  "internal_error",
  "service_unavailable",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    // `details` is optional and exactOptionalPropertyTypes is on, so absence is
    // recorded as an explicit `undefined` rather than an omitted property. Both
    // serialise identically once the error handler strips the key.
    this.details = details;
  }
}

/**
 * The single "you cannot see this" answer.
 *
 * A caller that lacks access, a caller asking about a row that does not exist, and
 * a caller asking about a row in a tenant it cannot name all receive this. Making
 * them distinguishable is how a "not found" becomes an existence oracle, and the
 * specification is explicit that an unauthorized object must not be observable
 * through an error any more than through a count or a timing.
 */
export function notFound(what: string): ApiError {
  return new ApiError("not_found", `${what} not found`, 404);
}

/** The audience refusal. A valid token with the wrong audience is a 403, never a 401. */
export function audienceMismatch(required: string): ApiError {
  return new ApiError(
    "audience_mismatch",
    `this credential is not authorized for the ${required} audience`,
    403,
    { required_audience: required },
  );
}

/** The profile refusal. The token is valid; the profile does not hold the tool. */
export function profileInsufficient(tool: string, profile: string): ApiError {
  return new ApiError(
    "profile_insufficient",
    `profile ${profile} does not hold ${tool}`,
    403,
    { tool, profile },
  );
}

/**
 * Map a `LedgerError` to its status.
 *
 * `LedgerError` already carries a status code chosen at the point the condition
 * was detected, which is the only place that knows whether an idempotency replay
 * is a conflict (different content) or a success (same content). Re-deriving it
 * here would throw that away, so the mapping only supplies the stable code and a
 * message that does not include the caller's own payload.
 */
export function fromLedgerError(error: LedgerError): ApiError {
  const codeByLedgerCode: Record<LedgerError["code"], ApiErrorCode> = {
    idempotency_conflict: "conflict",
    scope_out_of_authority: "forbidden",
    invalid_span: "validation_failed",
    sequence_conflict: "conflict",
    not_found: "not_found",
  };
  return new ApiError(codeByLedgerCode[error.code], error.message, error.statusCode);
}

interface FastifyValidationIssue {
  readonly instancePath?: string;
  readonly schemaPath?: string;
  readonly keyword?: string;
  readonly params?: Record<string, unknown>;
}

/**
 * Reduce Fastify's validation errors to a shape that carries no submitted values.
 *
 * `params` is filtered to keys that name a constraint rather than a value:
 * `additionalProperties` names the offending key (safe and useful — it is a key
 * the caller wrote), while `type`/`pattern` may carry the value itself and are
 * dropped.
 */
export function validationError(issues: readonly FastifyValidationIssue[]): ApiError {
  const safeKeys = new Set(["additionalProperties", "missingProperty", "limit", "comparison"]);
  const details = issues.map((issue) => {
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(issue.params ?? {})) {
      if (safeKeys.has(key)) params[key] = value;
    }
    return {
      path: issue.instancePath ?? "",
      rule: issue.keyword ?? "invalid",
      ...(Object.keys(params).length > 0 ? { constraint: params } : {}),
    };
  });
  return new ApiError("validation_failed", "request failed schema validation", 400, { issues: details });
}

export interface PgErrorLike {
  readonly code?: string;
  readonly constraint?: string;
  readonly severity?: string;
}

function isPgError(error: unknown): error is PgErrorLike {
  return typeof error === "object" && error !== null && typeof (error as PgErrorLike).code === "string";
}

/**
 * Translate an unexpected throw into a response without leaking internals.
 *
 * The database's SQLSTATE is preserved because it is short, stable and does not
 * contain data; the driver's message is discarded because it routinely contains the
 * failing statement text and the row's values. The full error goes to the logger,
 * which is where an operator can see it.
 *
 * `22P02` (`invalid_text_representation`) is the one SQLSTATE that is *not* a server
 * fault. It means a caller supplied an identifier that is the right shape for the
 * contract — `clm_[0-9a-zA-Z]{8,64}` — but not a UUID, because the contract's
 * identifier form is a prefixed hex string and the column is a UUID. The route's
 * `requireId` catches everything the pattern can catch; this catches the residue, and
 * reporting it as a 400 rather than a 500 is the difference between an operator
 * paging for a caller's typo and not.
 */
export function internalError(error: unknown): ApiError {
  if (isPgError(error)) {
    if (error.code === "22P02") {
      return new ApiError("validation_failed", "an identifier in the request is not a well-formed identifier", 400);
    }
    return new ApiError(
      "internal_error",
      "the request could not be completed because of a storage error",
      500,
      { sqlstate: error.code, ...(error.constraint ? { constraint: error.constraint } : {}) },
    );
  }
  return new ApiError("internal_error", "the request could not be completed", 500);
}

export interface ErrorHandlerOptions {
  readonly log: (error: unknown, request: FastifyRequest) => void;
}

/**
 * Install the error handler.
 *
 * Registered once on the root instance so that a thrown `ApiError`, a schema
 * failure and an unhandled crash all leave through the same door. Fastify's
 * default handler returns `{statusCode, error, message}`, which is a second error
 * shape and therefore a second thing for every client to parse.
 */
export function installErrorHandler(app: FastifyInstance, options: ErrorHandlerOptions): void {
  app.setErrorHandler((error, request, reply) => {
    const candidate = error as { validation?: FastifyValidationIssue[]; statusCode?: number };

    if (candidate.validation && candidate.validation.length > 0) {
      send(reply, validationError(candidate.validation));
      return;
    }
    if (error instanceof ApiError) {
      send(reply, error);
      return;
    }
    if (error instanceof LedgerError) {
      send(reply, fromLedgerError(error));
      return;
    }
    // A body Fastify itself rejected before a handler ran: unsupported media type,
    // unparseable JSON, payload too large. These have a status but no code, and
    // they must still leave in the single error shape.
    const status = typeof candidate.statusCode === "number" ? candidate.statusCode : 500;
    if (status >= 400 && status < 500) {
      // 415 and 413 are the two a client can actually act on, and both are the
      // client's fault rather than a server fault, so they stay in the 4xx family
      // with the same code as any other malformed request.
      send(reply, new ApiError("validation_failed", "the request could not be parsed or accepted", status));
      return;
    }

    options.log(error, request);
    send(reply, internalError(error));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    // The route list is public knowledge — it is in the OpenAPI document at /docs —
    // so naming the path in the message discloses nothing. Naming what *exists at*
    // the path would.
    send(reply, new ApiError("not_found", `no route for ${request.method} ${request.url}`, 404));
  });
}

function send(reply: FastifyReply, error: ApiError): void {
  const body: ApiErrorBody =
    error.details === undefined
      ? { error: { code: error.code, message: error.message } }
      : { error: { code: error.code, message: error.message, details: error.details } };
  void reply.code(error.statusCode).send(body);
}
