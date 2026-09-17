/**
 * `@veritymem/sdk-ts` — the typed client over the REST API, plus the
 * deliberately Mem0-shaped facade used as the specification's demand test.
 *
 * The two entry points are separate on purpose: `@veritymem/sdk-ts` is the real
 * client and `@veritymem/sdk-ts/facade` is an instrumented adoption experiment.
 * Making a caller import the facade explicitly keeps the experiment visible in
 * their import list, which is the point.
 */
export {
  VerityMemClient,
  type ExtractionRunResponse,
  type FeedbackReceipt,
  type FetchLike,
  type QueryTrace,
  type ReverificationRequest,
  type VerityMemClientOptions,
} from "./client.ts";
export {
  HTTP_STATUS,
  VerityMemError,
  isVerityMemError,
  type VerityMemErrorBody,
  type VerityMemErrorInit,
} from "./errors.ts";
