#!/usr/bin/env node
/**
 * The `veritymem-mcp` stdio entry point: local-first, one process per client.
 *
 * stdio is the transport the MCP ecosystem actually uses for local tooling, and
 * it has one property worth stating: the process lives for the whole session, so
 * a long-running agent keeps one capability token. That is why
 * `authorizeToolCall` re-checks token expiry on every call rather than only at
 * startup — a session that outlives its credential must stop working, not keep
 * working until it reconnects.
 *
 * Configuration:
 *
 *   VERITYMEM_API_URL    REST origin. Default http://127.0.0.1:8080.
 *   VERITYMEM_MCP_TOKEN  base64url capability token (see `encodeCapabilityToken`).
 *                        Absent means a local-operator session: the default
 *                        `contributor` profile, one tenant, no privileged tools.
 *   VERITYMEM_TENANT     Tenant for a session with no token. Default "default".
 *   VERITYMEM_PURPOSE    Comma-separated purposes for a session with no token.
 *                        Default "agent_memory".
 *   VERITYMEM_ADMIN_TOKEN  Bearer credential used for admin-audience routes
 *                        (grants, forget). Only reached by a privacy-admin token.
 *
 * NOTE ON INVOCATION: the shebang is plain `node`, so this entry point needs
 * Node's type stripping, which is on by default from Node 22.18/23.6 but is a flag
 * on Node 22.6–22.17. On those versions run
 * `node --experimental-strip-types $(which veritymem-mcp)`, or set
 * `NODE_OPTIONS=--experimental-strip-types`. This package ships TypeScript without
 * a build step, matching the rest of the repository.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VerityMemClient } from "@veritymem/sdk-ts";
import { pathToFileURL } from "node:url";
import { decodeCapabilityToken, sessionFromToken } from "./auth.ts";
import { createVerityMemServer } from "./server.ts";

const DEFAULT_API_URL = "http://127.0.0.1:8080";

/**
 * Starts the server on stdio.
 *
 * Exported rather than run at import time so a test can exercise configuration
 * parsing without starting a transport, which would attach the process to stdin.
 */
export async function runStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const apiUrl = env["VERITYMEM_API_URL"] ?? DEFAULT_API_URL;
  const tenant = env["VERITYMEM_TENANT"] ?? "default";
  const purposes = (env["VERITYMEM_PURPOSE"] ?? "agent_memory")
    .split(",")
    .map((purpose) => purpose.trim())
    .filter((purpose) => purpose !== "");
  if (purposes.length === 0) {
    // Purpose is a hard boundary, and a session with none can reach nothing.
    // Exiting with this message beats a session that answers "no memory" forever.
    process.stderr.write("veritymem-mcp: VERITYMEM_PURPOSE is set but empty; at least one purpose is required.\n");
    process.exitCode = 2;
    return;
  }

  const rawToken = env["VERITYMEM_MCP_TOKEN"];
  let token;
  if (rawToken !== undefined && rawToken !== "") {
    const decoded = decodeCapabilityToken(rawToken);
    if (!decoded.ok) {
      process.stderr.write(`veritymem-mcp: refusing to start with an invalid capability token: ${decoded.reason}\n`);
      process.exitCode = 2;
      return;
    }
    token = decoded.token;
  }

  const session = sessionFromToken(token, { tenant, purposes });
  const client = new VerityMemClient({
    baseUrl: apiUrl,
    ...(env["VERITYMEM_TOKEN"] === undefined ? {} : { token: env["VERITYMEM_TOKEN"] }),
    ...(env["VERITYMEM_ADMIN_TOKEN"] === undefined ? {} : { adminToken: env["VERITYMEM_ADMIN_TOKEN"] }),
  });

  const handle = createVerityMemServer({ backend: client, session });
  const transport = new StdioServerTransport();
  await handle.server.connect(transport);
  process.stderr.write(
    `veritymem-mcp: serving profile "${session.profile}" for tenant "${session.tenant}" against ${apiUrl}; tools: ${handle.registeredTools.join(", ")}\n`,
  );
}

// Only attach to stdio when executed as the entry point, so importing this module
// in a test does not consume the parent process's stdin. Compared as resolved file
// URLs rather than strings, because pnpm's bin shim execs this through a symlink.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await runStdio();
}
