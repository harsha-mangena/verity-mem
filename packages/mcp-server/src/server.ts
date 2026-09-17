/**
 * Composition: one server definition, any number of capabilities.
 *
 * The profile is fixed when the server is created, and registration is derived
 * from it in {@link registerToolsForProfile}. Registration is therefore the only
 * place a privileged tool can enter a session, and there is exactly one of them —
 * which is what makes "never registered in an ordinary agent session" a property
 * of the code rather than a promise in a README.
 *
 * It is still not a security boundary. See the comment inside
 * {@link registerToolsForProfile}: the tool layer re-authorizes every call, and
 * that comment sits where a reader would otherwise conclude that hiding a tool is
 * sufficient.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AuthorizedSession, ToolName } from "./auth.ts";
import { toolsForProfile } from "./auth.ts";
import { callTool, toolInputSchema, toolMetadata, type ToolBackend } from "./tools.ts";

/** The implementation name and version clients see during `initialize`. */
export const SERVER_INFO = { name: "veritymem", version: "0.1.0" } as const;

/**
 * A handler with the SDK's argument type already erased.
 *
 * The SDK passes validated arguments as `unknown` to the callback and holds them
 * in a private handler table, so the callback type is contravariant in a way a
 * generic cannot express through `registerTool`. Everything crossing this seam has
 * already been validated on the client side and is re-validated by the tool layer,
 * which is why erasing the type here is safe rather than merely convenient.
 */
type ErasedToolCallback = (args: unknown) => Promise<CallToolResult>;

/** Narrow structural view of the SDK's registered-tool handle, for tests and shutdown. */
interface RegisteredToolHandle {
  disable(): void;
  enable(): void;
}

/** The tool names this server advertised, in registration order. */
export interface VerityMemServerHandle {
  readonly server: McpServer;
  readonly session: AuthorizedSession;
  /** The exact tools registered for this profile. Privileged tools are absent for `contributor`. */
  readonly registeredTools: readonly ToolName[];
  /** Underlying SDK handles, exposed so `close()` can be awaited deterministically. */
  readonly handles: readonly RegisteredToolHandle[];
  /**
   * How many tool calls have reached the authorization check.
   *
   * A caller can read this after a transport round trip to confirm that the check
   * ran for a call the client never saw advertised — which is the whole claim of
   * "tool visibility is not a security boundary".
   */
  readonly authorizationChecks: { count: number };
}

export interface CreateServerOptions {
  readonly backend: ToolBackend;
  readonly session: AuthorizedSession;
  /** Injected clock, so tool handlers never depend on wall time in tests. */
  readonly now?: () => Date;
  /** Overrides {@link SERVER_INFO}, used by tests to prove the factory is used. */
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

/**
 * Registers exactly the tools a profile grants.
 *
 * Privileged tools are **not registered** for `reader` and `contributor`, so a
 * well-behaved client cannot discover them. That is a usability property and not
 * a security one: a client can still send `tools/call` for any name it likes, and
 * a model that has read retrieved memory can be persuaded to try. Every call is
 * re-authorized in `callTool` regardless of what was advertised here, and the
 * refusal is returned as a readable tool error.
 */
export function registerToolsForProfile(handle: {
  readonly server: McpServer;
  readonly backend: ToolBackend;
  readonly session: AuthorizedSession;
  readonly now: () => Date;
  readonly authorizationChecks?: { count: number };
}): { readonly tools: readonly ToolName[]; readonly handles: readonly RegisteredToolHandle[] } {
  const tools = toolsForProfile(handle.session.profile);
  const handles: RegisteredToolHandle[] = [];

  for (const tool of tools) {
    const metadata = toolMetadata(tool);
    const inputSchema = toolInputSchema(tool);
    const callback: ErasedToolCallback = async (args: unknown) => {
      const result = await callTool(tool, args, {
        session: handle.session,
        backend: handle.backend,
        now: handle.now,
        ...(handle.authorizationChecks === undefined ? {} : { authorizationChecks: handle.authorizationChecks }),
      });
      if (result.ok) {
        return { content: [{ type: "text", text: JSON.stringify(result.value) }] };
      }
      // `isError` is the MCP-standard way to report a refused call. The refusal
      // carries its code so the model can distinguish "you may not" from
      // "the request was malformed" from "the backend broke".
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: result.code, message: result.message }) }],
      };
    };

    const registered = handle.server.registerTool(
      tool,
      { title: metadata.title, description: metadata.description, inputSchema: inputSchema as unknown as z.ZodRawShape },
      callback as unknown as Parameters<McpServer["registerTool"]>[2],
    );
    handles.push(registered as unknown as RegisteredToolHandle);
  }

  return { tools, handles };
}

/**
 * Builds an MCP server for one session.
 *
 * "One server, two transports" is realised here and in `http.ts`/`stdio.ts`: the
 * transports differ only in how bytes arrive, and both call this factory, so the
 * tool surface, the profile rules and the authorization path cannot drift between
 * them.
 */
export function createVerityMemServer(options: CreateServerOptions): VerityMemServerHandle {
  const server = new McpServer(options.serverInfo ?? SERVER_INFO);
  const now = options.now ?? (() => new Date());
  const authorizationChecks = { count: 0 };
  const { tools, handles } = registerToolsForProfile({
    server,
    backend: options.backend,
    session: options.session,
    now,
    authorizationChecks,
  });
  return { server, session: options.session, registeredTools: tools, handles, authorizationChecks };
}
