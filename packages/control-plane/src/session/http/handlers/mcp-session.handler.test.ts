import { describe, expect, it, vi } from "vitest";
import { McpSessionHandler, type McpSessionBridge } from "./mcp-session.handler";

function harness(
  options: {
    sessionCapability?: "off" | "read_only" | "enabled";
    liveMode?: "off" | "read_only" | "enabled";
    actorId?: string | null;
    sharedServers?: Array<{ serverId: string; serverName: string; toolNames: string[] }>;
    sharedResult?: unknown;
    grants?: Array<{
      id: string;
      connectionId: string;
      serverName: string;
      endpointHost: string;
      toolNames: string[];
      sessionId: string;
      createdAt: number;
      ownerUserId: string;
    }>;
    result?: unknown;
    failure?: string;
  } = {}
) {
  const grants = options.grants ?? [
    {
      id: "pin-1",
      connectionId: "mcpconn_1",
      serverName: "Docs",
      endpointHost: "mcp.example.com",
      toolNames: ["search"],
      sessionId: "session-1",
      createdAt: 1_000,
      ownerUserId: "user-1",
    },
  ];
  const callTool = vi.fn(async () => {
    if (options.failure) throw new Error(options.failure);
    return options.result ?? { hits: ["one"] };
  });
  const audit = vi.fn(async () => undefined);
  const bridge: McpSessionBridge = {
    liveMode: () => options.liveMode ?? "enabled",
    sessionCapability: () => options.sessionCapability ?? "enabled",
    grants: async () => grants,
    callTool,
    audit,
    operationActor: () => (options.actorId === undefined ? "user-1" : options.actorId),
    sharedServers: vi.fn(async () =>
      options.sharedServers === undefined
        ? []
        : options.sharedServers.map((server) => ({
            serverId: server.serverId,
            serverName: server.serverName,
            endpointHost: "mcp.example.com",
            toolNames: server.toolNames,
          }))
    ),
    callSharedTool: vi.fn(async () => options.sharedResult ?? { shared: true }),
    grantPin: vi.fn(async () => ({
      id: "pin-1",
      sessionId: "session-1",
      connectionId: "mcpconn_1",
      toolNames: ["search"],
      createdAt: 1_000,
    })),
  };
  const handler = new McpSessionHandler({
    mcp: bridge,
    getSessionId: () => "session-1",
  });
  return { handler, callTool, audit };
}

const request = {
  connectionId: "mcpconn_1",
  toolName: "search",
  arguments: { query: "open inspect" },
};

function readRequest(body: unknown = request, operationId = "message-1") {
  return new Request("http://session/internal/pi-mcp/read", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pi-Operation-ID": operationId,
      "X-Request-ID": "request-1",
    },
    body: JSON.stringify(body),
  });
}

describe("McpSessionHandler", () => {
  it("reads a reviewed tool through the owning session", async () => {
    const h = harness();

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connectionId: "mcpconn_1",
      toolName: "search",
      content: { hits: ["one"] },
      truncated: false,
    });
    expect(h.callTool).toHaveBeenCalledWith({
      connectionId: "mcpconn_1",
      toolName: "search",
      arguments: { query: "open inspect" },
    });
  });

  it("refuses a read when the session capability is off", async () => {
    const h = harness({ sessionCapability: "off" });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "mcp_reads_disabled" });
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it("refuses a read when the live deployment mode denies it", async () => {
    const h = harness({ liveMode: "read_only" });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(403);
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it("refuses a connection that was never granted to the session", async () => {
    const h = harness();

    const response = await h.handler.read(
      readRequest({ ...request, connectionId: "mcpconn_other" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "mcp_connection_not_granted",
    });
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "refused", reasonCode: "mcp_connection_not_granted" })
    );
  });

  it("refuses a tool that is not part of the reviewed catalog", async () => {
    const h = harness();

    const response = await h.handler.read(readRequest({ ...request, toolName: "delete" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "mcp_tool_not_reviewed" });
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it("refuses a read with no human actor", async () => {
    const h = harness({ actorId: null });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(403);
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it("refuses a read with no active operation", async () => {
    const h = harness();

    const response = await h.handler.read(readRequest(request, ""));

    expect(response.status).toBe(409);
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it("bounds an oversized provider result and says so", async () => {
    const h = harness({ result: { blob: "x".repeat(200_000) } });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(200);
    const body = await response.json<{ truncated: boolean; content: { preview: string } }>();
    expect(body.truncated).toBe(true);
    expect(body.content.preview.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("refuses a provider answer that carries a credential", async () => {
    const h = harness({ result: { account: { accessToken: "gho_secret" } } });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "mcp_result_not_credential_free",
    });
    // The credential never leaves the session.
    expect(JSON.stringify(body)).not.toContain("gho_secret");
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "refused", reasonCode: "mcp_result_carried_a_credential" })
    );
  });

  it("reports a failed provider call without inventing a result", async () => {
    const h = harness({ failure: "the provider refused" });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "mcp_tool_failed" });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "refused", reasonCode: "mcp_tool_failed" })
    );
  });

  it("refuses a grant list with no active operation", async () => {
    const h = harness();

    const response = await h.handler.list(new Request("http://session/internal/pi-mcp/list"));

    expect(response.status).toBe(409);
  });

  it("reads a reviewed tool on a shared server the session may use", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcp_1", serverName: "Docs", toolNames: ["search"] }],
    });

    const response = await h.handler.read(
      new Request("http://session/internal/pi-mcp/read", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": "operation-1" },
        body: JSON.stringify({ serverId: "mcp_1", toolName: "search", arguments: {} }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      serverId: "mcp_1",
      toolName: "search",
      content: { shared: true },
    });
  });

  it("refuses a shared server the session may not use", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcp_1", serverName: "Docs", toolNames: ["search"] }],
    });

    const response = await h.handler.read(
      new Request("http://session/internal/pi-mcp/read", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": "operation-1" },
        body: JSON.stringify({ serverId: "mcp_2", toolName: "search", arguments: {} }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "mcp_server_not_available",
    });
  });

  it("refuses a shared tool that is not in the reviewed catalog", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcp_1", serverName: "Docs", toolNames: ["search"] }],
    });

    const response = await h.handler.read(
      new Request("http://session/internal/pi-mcp/read", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": "operation-1" },
        body: JSON.stringify({ serverId: "mcp_1", toolName: "delete_everything", arguments: {} }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "mcp_tool_not_reviewed" });
  });

  it("refuses a shared answer that carries a credential", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcp_1", serverName: "Docs", toolNames: ["search"] }],
      sharedResult: { account: { accessToken: "gho_secret" } },
    });

    const response = await h.handler.read(
      new Request("http://session/internal/pi-mcp/read", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": "operation-1" },
        body: JSON.stringify({ serverId: "mcp_1", toolName: "search", arguments: {} }),
      })
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ code: "mcp_result_not_credential_free" });
    expect(JSON.stringify(body)).not.toContain("gho_secret");
  });

  it("lists the session's authorized attachments without a credential", async () => {
    const h = harness();

    const response = await h.handler.list(
      new Request("http://session/internal/pi-mcp/list", {
        headers: { "X-Pi-Operation-ID": "operation-1" },
      })
    );

    expect(response.status).toBe(200);
    // The canonical pin shape, so the agent and the session agree on one.
    const body = await response.json<{ pins: Array<Record<string, unknown>> }>();
    expect(body.pins).toHaveLength(1);
    // The owner of the connection is not part of the answer.
    expect(JSON.stringify(body)).not.toMatch(/token|secret|authorization|ownerUserId/i);
  });
});
