import { describe, expect, it, vi } from "vitest";
import { McpSessionHandler, type McpSessionBridge } from "./mcp-session.handler";

function harness(
  options: {
    sessionCapability?: "off" | "read_only" | "enabled";
    liveMode?: "off" | "read_only" | "enabled";
    actorId?: string | null;
    sharedServers?: Array<{ serverId: string; serverName: string; toolNames: string[] }>;
    sharedResult?: unknown;
    failure?: string;
  } = {}
) {
  const callSharedTool = vi.fn(async () => {
    if (options.failure) throw new Error(options.failure);
    return options.sharedResult ?? { hits: ["one"] };
  });
  const bridge: McpSessionBridge = {
    liveMode: () => options.liveMode ?? "enabled",
    sessionCapability: () => options.sessionCapability ?? "enabled",
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
    callSharedTool,
    operationActor: () => (options.actorId === undefined ? "user-1" : options.actorId),
  };
  const handler = new McpSessionHandler({
    mcp: bridge,
    getSessionId: () => "session-1",
  });
  return { handler, callSharedTool };
}

const request = {
  serverId: "mcpsrv_1",
  toolName: "search",
  arguments: { query: "open inspect" },
};

function readRequest(body: unknown = request, headers: Record<string, string> = {}) {
  return new Request("http://session/internal/pi-mcp/read", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pi-Operation-ID": "operation-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("the shared MCP gateway", () => {
  it("reads one reviewed tool on a shared server", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcpsrv_1", serverName: "Docs", toolNames: ["search"] }],
    });

    const response = await h.handler.read(readRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      serverId: "mcpsrv_1",
      toolName: "search",
      content: { hits: ["one"] },
      truncated: false,
    });
    expect(h.callSharedTool).toHaveBeenCalledWith(request);
  });

  it("refuses a read when the session does not hold the capability", async () => {
    const h = harness({ sessionCapability: "off" });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(403);
    expect(h.callSharedTool).not.toHaveBeenCalled();
  });

  it("refuses a read that names no active turn", async () => {
    const h = harness();

    const response = await h.handler.read(readRequest(request, { "X-Pi-Operation-ID": "" }));

    expect(response.status).toBe(409);
  });

  it("refuses a server this session may not use", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcpsrv_2", serverName: "Docs", toolNames: ["search"] }],
    });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mcp_server_not_available" });
  });

  it("refuses a tool the reviewed catalog does not carry", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcpsrv_1", serverName: "Docs", toolNames: ["other"] }],
    });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mcp_tool_not_reviewed" });
  });

  it("never carries the provider's own error to the model", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcpsrv_1", serverName: "Docs", toolNames: ["search"] }],
      failure: "the provider said something private",
    });

    const response = await h.handler.read(readRequest());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("refuses a provider answer that carries a credential", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcpsrv_1", serverName: "Docs", toolNames: ["search"] }],
      sharedResult: { accessToken: "gho_secret" },
    });

    const response = await h.handler.read(readRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "mcp_result_not_credential_free" });
  });

  it("lists only the shared servers the session may read", async () => {
    const h = harness({
      sharedServers: [{ serverId: "mcpsrv_1", serverName: "Docs", toolNames: ["search"] }],
    });

    const response = await h.handler.list(
      new Request("http://session/internal/pi-mcp/list", {
        headers: { "X-Pi-Operation-ID": "operation-1" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      shared: [
        {
          serverId: "mcpsrv_1",
          serverName: "Docs",
          endpointHost: "mcp.example.com",
          toolNames: ["search"],
        },
      ],
    });
  });

  it("lists nothing when the session does not hold the capability", async () => {
    const h = harness({ sessionCapability: "off" });

    const response = await h.handler.list(
      new Request("http://session/internal/pi-mcp/list", {
        headers: { "X-Pi-Operation-ID": "operation-1" },
      })
    );

    expect(await response.json()).toEqual({ shared: [] });
  });
});
