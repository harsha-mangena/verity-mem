/**
 * `@veritymem/sdk-ts` — the typed client over the REST API.
 *
 * The deliberately Mem0-shaped facade used for the specification's demand test
 * lives behind its own entry point, `@veritymem/sdk-ts/facade`. The split is on
 * purpose: `add()`/`search()` are an instrumented adoption experiment, and making
 * a caller import that path explicitly keeps the experiment visible in their
 * import list rather than letting it become the default way in.
 */
export {
  VerityMemClient,
  type FetchLike,
  type VerityMemClientOptions,
} from "./client.ts";
export {
  HTTP_STATUS,
  VerityMemError,
  isVerityMemError,
  type VerityMemErrorBody,
  type VerityMemErrorInit,
} from "./errors.ts";
