import {
  MAX_MCP_READ_RESULT_BYTES,
  mcpReadRequestSchema,
  mcpReadResultSchema,
  type McpReadResult,
} from "@open-inspect/shared/types/mcp-read";
import type { FeatureCapabilityMode } from "@open-inspect/shared/capability-modes";

/**
 * The MCP gateway inside the owning session.
 *
 * A shared MCP server belongs to the deployment. The session revalidates the
 * server's repository scope and its reviewed catalog before anything reaches
 * the provider, and it returns a bounded, credential-free result.
 */
export interface McpSessionBridge {
  /** The live deployment mode for MCP reads. */
  liveMode(): FeatureCapabilityMode;
  /** The latched capability of this session. */
  sessionCapability(): FeatureCapabilityMode;
  /**
   * The shared servers this session may use.
   *
   * They are the deployment's own servers, resolved the way the sandbox
   * resolves them: by the session's repositories. Only their reviewed
   * read-only tools are listed.
   */
  sharedServers(): Promise<
    Array<{
      serverId: string;
      serverName: string;
      endpointHost: string;
      toolNames: string[];
    }>
  >;
  /**
   * Invoke one reviewed read-only tool on a shared server.
   *
   * The deployment's credential is closed over inside the call.
   */
  callSharedTool(request: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  /** The human actor whose turn the current operation belongs to. */
  operationActor(operationId: string): string | null;
  /** Re-read the turn author's current authority before every operation. */
  authorMayAct(operationId: string): Promise<boolean>;
}

export interface McpSessionHandlerOptions {
  mcp: McpSessionBridge;
  getSessionId: () => string;
}

export class McpSessionHandler {
  constructor(private readonly options: McpSessionHandlerOptions) {}

  /** The shared servers this session may read. It never names a credential. */
  async list(request: Request): Promise<Response> {
    const bridge = this.options.mcp;
    if (bridge.sessionCapability() === "off" || bridge.liveMode() === "off") {
      return Response.json({ shared: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    // The catalog is the session's capability surface. It names the turn it
    // belongs to, exactly as the read does.
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId) {
      return Response.json(
        { error: "An MCP catalog list requires an active operation" },
        { status: 409 }
      );
    }
    if (!(await bridge.authorMayAct(operationId))) {
      return Response.json(
        { error: "The originating turn's author may no longer act on this session" },
        { status: 403 }
      );
    }
    const shared = await bridge.sharedServers();
    return Response.json(
      {
        shared: shared.map((server) => ({
          serverId: server.serverId,
          serverName: server.serverName,
          endpointHost: server.endpointHost,
          toolNames: server.toolNames,
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  /**
   * Read one reviewed tool.
   *
   * The order is the boundary: the gate, the server's scope, the reviewed
   * catalog, and only then the provider.
   */
  async read(request: Request): Promise<Response> {
    const bridge = this.options.mcp;
    const parsed = mcpReadRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid MCP read request" }, { status: 400 });
    }
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId) {
      return Response.json({ error: "An MCP read requires an active operation" }, { status: 409 });
    }
    if (bridge.sessionCapability() !== "enabled" || bridge.liveMode() !== "enabled") {
      return Response.json(
        {
          error: "MCP reads are disabled for this session",
          code: "mcp_reads_disabled",
        },
        { status: 403 }
      );
    }
    const actorId = bridge.operationActor(operationId);
    if (!actorId) {
      return Response.json({ error: "The originating turn has no human actor" }, { status: 403 });
    }
    if (!(await bridge.authorMayAct(operationId))) {
      return Response.json(
        { error: "The originating turn's author may no longer act on this session" },
        { status: 403 }
      );
    }

    // The shared lane: the deployment's own server, resolved by the
    // session's repositories, with the reviewed read-only catalog.
    const servers = await bridge.sharedServers();
    const server = servers.find((entry) => entry.serverId === parsed.data.serverId);
    if (!server) {
      return Response.json(
        {
          error: "This MCP server is not available to this session",
          code: "mcp_server_not_available",
        },
        { status: 403 }
      );
    }
    if (!server.toolNames.includes(parsed.data.toolName)) {
      return Response.json(
        {
          error: "This MCP tool is not part of the reviewed catalog",
          code: "mcp_tool_not_reviewed",
        },
        { status: 403 }
      );
    }
    let content: unknown;
    try {
      content = await bridge.callSharedTool({
        serverId: parsed.data.serverId,
        toolName: parsed.data.toolName,
        arguments: parsed.data.arguments,
      });
    } catch {
      // The provider's own string stays in the platform; the model only
      // learns that the tool did not complete.
      return Response.json(
        { error: "The MCP tool did not complete", code: "mcp_tool_failed" },
        { status: 502 }
      );
    }
    const bounded = boundResult(content);
    // The gateway is the boundary. A provider answer that carries a
    // credential-shaped key is refused here, so it never leaves the session
    // and never reaches the model or the timeline.
    const credentialFree = mcpReadResultSchema.safeParse({
      serverId: parsed.data.serverId,
      toolName: parsed.data.toolName,
      content: bounded.content,
      truncated: bounded.truncated,
    });
    if (!credentialFree.success) {
      return Response.json(
        {
          error: "The MCP tool returned a result this session may not carry",
          code: "mcp_result_not_credential_free",
        },
        { status: 502 }
      );
    }
    return Response.json(
      {
        serverId: parsed.data.serverId,
        toolName: parsed.data.toolName,
        content: bounded.content,
        truncated: bounded.truncated,
      } satisfies McpReadResult,
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}

/**
 * Bound one provider result.
 *
 * A provider may answer with anything, including something enormous. The
 * result is cut to a size the agent can hold, and the cut is stated rather
 * than hidden.
 */
export function boundResult(content: unknown): { content: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(content ?? null);
  } catch {
    return { content: null, truncated: true };
  }
  if (serialized.length <= MAX_MCP_READ_RESULT_BYTES) {
    return { content, truncated: false };
  }
  return {
    content: {
      truncated: true,
      note: "The provider result was larger than the bound the session allows.",
      preview: serialized.slice(0, MAX_MCP_READ_RESULT_BYTES),
    },
    truncated: true,
  };
}
