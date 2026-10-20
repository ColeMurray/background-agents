import { describe, expect, it, vi } from "vitest";
import { McpSessionHandler, type McpSessionBridge } from "./mcp-session.handler";

function harness(
  options: {
    sessionCapability?: "off" | "read_only" | "enabled";
    liveMode?: "off" | "read_only" | "enabled";
    actorId?: string | null;
    grants?: Array<{
      id: string;
      connectionId: string;
      serverName: string;
      endpointHost: string;
      toolNames: string[];
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

  it("reports a failed provider call without inventing a result", async () => {
    const h = harness({ failure: "the provider refused" });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "mcp_tool_failed" });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "refused", reasonCode: "mcp_tool_failed" })
    );
  });

  it("lists the session's authorized attachments without a credential", async () => {
    const h = harness();

    const response = await h.handler.list();

    expect(response.status).toBe(200);
    const body = await response.json<{ grants: unknown[] }>();
    expect(body.grants).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/token|secret|authorization/i);
  });
});
