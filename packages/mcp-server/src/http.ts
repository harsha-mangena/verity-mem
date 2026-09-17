/**
 * Streamable HTTP transport.
 *
 * Stateless by construction: one `McpServer` and one transport per request,
 * both closed when the response is delivered. That choice removes session state
 * from the security surface. A shared session would have to decide whose
 * credential it was initialized with, and the specification's premise is that an
 * agent token reaching a privileged route is a design failure — so the credential
 * is re-read from every request and the session it produces lives only as long as
 * that request does.
 *
 * The bearer token is a base64url capability token (see `auth.ts`). It is
 * unsigned and therefore untrusted: `decodeCapabilityToken` validates its shape
 * and `authorizeToolCall` enforces the profile ceiling regardless of what the
 * token claims.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { decodeCapabilityToken, sessionFromToken, type AuthorizedSession, type CapabilityToken } from "./auth.ts";
import { createVerityMemServer } from "./server.ts";
import { type ToolBackend } from "./tools.ts";

/** Path the transport is mounted at. The specification names no path; `/mcp` is the convention. */
export const DEFAULT_HTTP_PATH = "/mcp";

/**
 * Configuration for the Streamable HTTP transport.
 *
 * Every field has a safe default; `backend` is required because a transport with
 * no API behind it would answer every call with a refusal.
 */
export interface HttpServerOptions {
  readonly backend: ToolBackend;
  /** Host to bind. Defaults to `127.0.0.1`: a memory layer should not be on the network by accident. */
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  /** Tenant a caller without a capability token is bound to. */
  readonly defaultTenant?: string;
  /** Purposes a caller without a capability token is bound to. */
  readonly defaultPurposes?: readonly string[];
  readonly now?: () => Date;
}

/** A started server and the exact URL it is listening on. */
export interface RunningHttpServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Resolves the session for one request.
 *
 * A caller with no token gets an explicit, named session rather than an anonymous
 * one: `AuthorizedSession` has no representation for "no tenant", and an
 * unauthenticated request that silently becomes a tenant-wide request is the
 * failure this shape prevents.
 */
export function resolveHttpSession(
  authorizationHeader: string | undefined,
  options: { readonly defaultTenant: string; readonly defaultPurposes: readonly string[] },
): { readonly ok: true; readonly session: AuthorizedSession } | { readonly ok: false; readonly status: number; readonly message: string } {
  const encoded = bearerToken(authorizationHeader);
  if (encoded === undefined) {
    return {
      ok: true,
      session: sessionFromToken(undefined, { tenant: options.defaultTenant, purposes: options.defaultPurposes }),
    };
  }

  const decoded = decodeCapabilityToken(encoded);
  if (!decoded.ok) {
    return { ok: false, status: 401, message: `Invalid capability token: ${decoded.reason}` };
  }
  return { ok: true, session: sessionFromToken(decoded.token, { tenant: options.defaultTenant, purposes: options.defaultPurposes }) };
}

/**
 * Starts the Streamable HTTP server.
 *
 * Kept as a plain `node:http` server rather than Fastify: `apps/server` owns the
 * Fastify application, and a second framework instance inside a package would be
 * two upgrade paths for one transport. `attach` below mounts this onto an existing
 * Node request listener for deployments that front both surfaces on one port.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const path = options.path ?? DEFAULT_HTTP_PATH;
  const server = createServer((request, response) => {
    void handleRequest(request, response, { ...options, path }).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "internal_error", message: error instanceof Error ? error.message : String(error) }));
    });
  });

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8090;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    server,
    url: `http://${host}:${port}${path}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      });
    },
  };
}

/**
 * Handles one Streamable HTTP exchange.
 *
 * Exported so a deployment can mount the transport on an existing request
 * listener without starting a second server — the alternative was to duplicate
 * this function in every app that wants one port for both REST and MCP.
 */
export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions & { readonly path: string },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== options.path) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "not_found", message: `MCP is served at ${options.path}` }));
    return;
  }

  const resolved = resolveHttpSession(request.headers.authorization, {
    defaultTenant: options.defaultTenant ?? "default",
    defaultPurposes: options.defaultPurposes ?? ["agent_memory"],
  });
  if (!resolved.ok) {
    response.writeHead(resolved.status, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "unauthenticated", message: resolved.message }));
    return;
  }

  const body = await readJsonBody(request);
  if (body === undefined) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "invalid_body", message: "request body is not valid JSON" }));
    return;
  }

  // No `sessionIdGenerator`: the SDK treats its absence as stateless mode, which
  // is what this transport wants. Passing `undefined` explicitly is rejected under
  // `exactOptionalPropertyTypes`, and the distinction is real — a generator would
  // create a session this handler has already decided not to keep.
  //
  // The cast at the `connect` call below is forced by the SDK's own typings: its
  // concrete transport classes model optional callbacks as
  // `(() => void) | undefined`, which `exactOptionalPropertyTypes` refuses where
  // its `Transport` interface declares `onclose?: () => void`. The alternative
  // would be to weaken this repository's compiler settings for a dependency.
  const transport = new StreamableHTTPServerTransport();
  const handle = createVerityMemServer({
    backend: options.backend,
    session: resolved.session,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  try {
    await handle.server.connect(transport as unknown as Parameters<typeof handle.server.connect>[0]);
    // The transport owns the response from here. It is not closed on `finish`:
    // the SDK writes an SSE stream for notifications before the POST response
    // completes, and closing underneath it truncates that stream. The SDK's own
    // `onclose` path tears both down, and nothing is retained between requests.
    await transport.handleRequest(request, response, body);
  } finally {
    if (!response.writableEnded) response.end();
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
