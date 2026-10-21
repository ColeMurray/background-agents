import {
  MAX_MCP_READ_RESULT_BYTES,
  mcpReadRequestSchema,
  mcpReadResultSchema,
  type McpReadResult,
} from "@open-inspect/shared/types/mcp-read";
import type { FeatureCapabilityMode } from "@open-inspect/shared/pi-feature-capabilities";

/**
 * The MCP gateway inside the owning session.
 *
 * A personal MCP connection becomes readable by a session only through an
 * explicit grant by its owner. The session revalidates that grant, the
 * connection's reviewed catalog, and the tool's classification before
 * anything reaches the provider, and it returns a bounded, credential-free
 * result.
 */
export interface McpSessionBridge {
  /** The live deployment mode for MCP reads. */
  liveMode(): FeatureCapabilityMode;
  /** The latched capability of this session. */
  sessionCapability(): FeatureCapabilityMode;
  /** The active grants of this session. */
  grants(): Promise<
    Array<{
      id: string;
      connectionId: string;
      serverName: string;
      endpointHost: string;
      toolNames: string[];
      /** The session the grant was made for. */
      sessionId: string;
      /** When the grant was made. */
      createdAt: number;
      /** The account whose identity the provider sees. */
      ownerUserId: string;
    }>
  >;
  /**
   * Invoke one reviewed read-only tool through the connection's broker.
   *
   * The broker closes over the owner's credential; it never crosses back.
   */
  callTool(request: {
    connectionId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  /** Record the call in the workspace audit. */
  audit(input: {
    requestId: string;
    actorUserId: string;
    connectionId: string;
    toolName: string;
    outcome: "applied" | "refused";
    reasonCode: string;
    occurredAt: number;
  }): Promise<void>;
  /** The human actor whose turn the current operation belongs to. */
  operationActor(operationId: string): string | null;
  /**
   * Attach one of the owner's connections to this session.
   *
   * The session applies the server's repository scope, the same rule the
   * shared MCP servers obey, and writes the attachment itself. It returns a
   * refusal rather than throwing, so the caller learns the reason.
   */
  grantPin(input: {
    ownerUserId: string;
    connectionId: string;
    catalogSnapshotSha256: string;
    toolNames: string[];
  }): Promise<
    | {
        id: string;
        sessionId: string;
        connectionId: string;
        toolNames: string[];
        createdAt: number;
      }
    | { error: string }
  >;
}

export interface McpSessionHandlerOptions {
  mcp: McpSessionBridge;
  getSessionId: () => string;
}

export class McpSessionHandler {
  constructor(private readonly options: McpSessionHandlerOptions) {}

  /** The session's authorized attachments. It never names a credential. */
  /**
   * Attach one of the owner's connections to this session.
   *
   * The owner is named by the route, not by the body: the connection is the
   * caller's own, and the session decides whether the server may be used
   * here at all.
   */
  async grantPin(request: Request): Promise<Response> {
    const ownerUserId = request.headers.get("X-Mcp-Pin-Owner-ID");
    if (!ownerUserId) {
      return Response.json({ error: "The connection owner is required" }, { status: 400 });
    }
    const body = (await request.json().catch(() => null)) as {
      connectionId?: string;
      catalogSnapshotSha256?: string;
      toolNames?: string[];
    } | null;
    if (!body?.connectionId || !body.catalogSnapshotSha256 || !body.toolNames) {
      return Response.json({ error: "Invalid MCP grant request" }, { status: 400 });
    }
    const result = await this.options.mcp.grantPin({
      ownerUserId,
      connectionId: body.connectionId,
      catalogSnapshotSha256: body.catalogSnapshotSha256,
      toolNames: body.toolNames,
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: 403 });
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }

  async list(request: Request): Promise<Response> {
    const bridge = this.options.mcp;
    if (bridge.sessionCapability() === "off" || bridge.liveMode() === "off") {
      return Response.json({ pins: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    // The grant roster is the session's capability surface. It names the
    // turn it belongs to, exactly as the read does.
    if (!request.headers.get("X-Pi-Operation-ID")) {
      return Response.json(
        { error: "An MCP grant list requires an active operation" },
        { status: 409 }
      );
    }
    const grants = await bridge.grants();
    return Response.json(
      {
        pins: grants.map((grant) => ({
          id: grant.id,
          sessionId: grant.sessionId,
          connectionId: grant.connectionId,
          serverName: grant.serverName,
          endpointHost: grant.endpointHost,
          toolNames: grant.toolNames,
          createdAt: grant.createdAt,
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  /**
   * Read one reviewed tool.
   *
   * The order is the boundary: the gate, the grant, the reviewed catalog, and
   * only then the provider.
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

    const grants = await bridge.grants();
    const grant = grants.find((entry) => entry.connectionId === parsed.data.connectionId);
    if (!grant) {
      await bridge.audit({
        requestId: request.headers.get("X-Request-ID") ?? crypto.randomUUID(),
        actorUserId: actorId,
        connectionId: parsed.data.connectionId,
        toolName: parsed.data.toolName,
        outcome: "refused",
        reasonCode: "mcp_connection_not_granted",
        occurredAt: Date.now(),
      });
      return Response.json(
        {
          error: "This MCP connection is not granted to the session",
          code: "mcp_connection_not_granted",
        },
        { status: 403 }
      );
    }
    if (!grant.toolNames.includes(parsed.data.toolName)) {
      await bridge.audit({
        requestId: request.headers.get("X-Request-ID") ?? crypto.randomUUID(),
        actorUserId: actorId,
        connectionId: parsed.data.connectionId,
        toolName: parsed.data.toolName,
        outcome: "refused",
        reasonCode: "mcp_tool_not_reviewed",
        occurredAt: Date.now(),
      });
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
      content = await bridge.callTool({
        connectionId: parsed.data.connectionId,
        toolName: parsed.data.toolName,
        arguments: parsed.data.arguments,
      });
    } catch {
      await bridge.audit({
        requestId: request.headers.get("X-Request-ID") ?? crypto.randomUUID(),
        actorUserId: actorId,
        connectionId: parsed.data.connectionId,
        toolName: parsed.data.toolName,
        outcome: "refused",
        reasonCode: "mcp_tool_failed",
        occurredAt: Date.now(),
      });
      // The provider's own string stays in the audit; the model only learns
      // that the tool did not complete.
      return Response.json(
        {
          error: "The MCP tool did not complete",
          code: "mcp_tool_failed",
        },
        { status: 502 }
      );
    }

    const bounded = boundResult(content);
    // The gateway is the boundary. A provider answer that carries a
    // credential-shaped key is refused here, so it never leaves the session
    // and never reaches the model, the timeline, or the audit.
    const credentialFree = mcpReadResultSchema.safeParse({
      connectionId: parsed.data.connectionId,
      toolName: parsed.data.toolName,
      content: bounded.content,
      truncated: bounded.truncated,
    });
    if (!credentialFree.success) {
      await bridge.audit({
        requestId: request.headers.get("X-Request-ID") ?? crypto.randomUUID(),
        actorUserId: actorId,
        connectionId: parsed.data.connectionId,
        toolName: parsed.data.toolName,
        outcome: "refused",
        reasonCode: "mcp_result_carried_a_credential",
        occurredAt: Date.now(),
      });
      return Response.json(
        {
          error: "The MCP tool returned a result this session may not carry",
          code: "mcp_result_not_credential_free",
        },
        { status: 502 }
      );
    }
    await bridge.audit({
      requestId: request.headers.get("X-Request-ID") ?? crypto.randomUUID(),
      actorUserId: actorId,
      connectionId: parsed.data.connectionId,
      toolName: parsed.data.toolName,
      outcome: "applied",
      reasonCode: "mcp_tool_read",
      occurredAt: Date.now(),
    });
    return Response.json(
      {
        connectionId: parsed.data.connectionId,
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
