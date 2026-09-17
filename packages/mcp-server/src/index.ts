/**
 * `@veritymem/mcp-server` — one server, two transports.
 *
 * The narrow model-facing surface is the point of this package. What is exported
 * here is deliberately larger than what a model sees: the transports, the profile
 * table, the authorization check, the renderer and the tool handlers are all
 * public so that each can be tested and reviewed on its own, because "tool
 * visibility is not a security boundary" means the interesting control is the one
 * a client never sees.
 */
export {
  AGENT_TOOLS,
  DEFAULT_PROFILE,
  PRIVILEGED_TOOLS,
  PROFILE_TOOLS,
  authorizeToolCall,
  decodeCapabilityToken,
  encodeCapabilityToken,
  isPrivilegedTool,
  sessionFromToken,
  toolsForProfile,
  type AuthorizationDecision,
  type AuthorizedSession,
  type CallRequest,
  type CapabilityToken,
  type AgentToolName,
  type PrivilegedToolName,
  type ToolName,
} from "./auth.ts";
export {
  MAX_RENDER_CHARS,
  findRenderViolations,
  renderPacketForModel,
  type RenderOptions,
  type RenderResult,
} from "./render.ts";
export {
  ALL_TOOLS,
  callTool,
  createToolHandlers,
  toolInputSchema,
  toolMetadata,
  type ToolBackend,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./tools.ts";
export {
  SERVER_INFO,
  createVerityMemServer,
  registerToolsForProfile,
  type CreateServerOptions,
  type VerityMemServerHandle,
} from "./server.ts";
export {
  DEFAULT_HTTP_PATH,
  handleRequest,
  resolveHttpSession,
  startHttpServer,
  type HttpServerOptions,
  type RunningHttpServer,
} from "./http.ts";
export { runStdio } from "./stdio.ts";
