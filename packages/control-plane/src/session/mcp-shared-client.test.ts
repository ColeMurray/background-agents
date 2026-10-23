import { beforeEach, describe, expect, it, vi } from "vitest";
import { callSharedMcpTool, type McpSharedServer } from "./mcp-shared-client";

const transportMocks = vi.hoisted(() => ({
  clientConstructor: vi.fn(),
  transportConstructor: vi.fn(),
  connect: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client", () => ({
  Client: class {
    constructor(...args: unknown[]) {
      transportMocks.clientConstructor(...args);
    }

    connect = transportMocks.connect;
    callTool = transportMocks.callTool;
    close = transportMocks.close;
  },
  StreamableHTTPClientTransport: class {
    constructor(...args: unknown[]) {
      transportMocks.transportConstructor(...args);
    }
  },
}));

const server: McpSharedServer = {
  id: "mcp_1",
  name: "Docs",
  type: "remote",
  url: "https://mcp.example.com/mcp",
  endpointHost: "mcp.example.com",
  headers: { Authorization: "Bearer integration-static-secret" },
};

describe("callSharedMcpTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transportMocks.connect.mockResolvedValue(undefined);
    transportMocks.callTool.mockResolvedValue({ content: { hits: ["one"] } });
    transportMocks.close.mockResolvedValue(undefined);
  });

  it.each([
    ["plaintext", "http://mcp.example.com/mcp", "mcp.example.com"],
    ["a private host", "https://169.254.169.254/mcp", "169.254.169.254"],
    ["a host other than the reviewed host", "https://evil.example.net/mcp", "mcp.example.com"],
  ])(
    "refuses %s before constructing a transport with static headers",
    async (_label, url, host) => {
      await expect(
        callSharedMcpTool({ ...server, url, endpointHost: host }, "search", {})
      ).rejects.toBeInstanceOf(Error);

      expect(transportMocks.clientConstructor).not.toHaveBeenCalled();
      expect(transportMocks.transportConstructor).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["a string", "Bearer integration-static-secret"],
    ["a neutral field", { note: "Bearer integration-static-secret" }],
  ])("rejects a configured static credential echoed through %s", async (_label, content) => {
    transportMocks.callTool.mockResolvedValue({ content });

    const error = await callSharedMcpTool(server, "search", {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: The MCP tool did not complete");
    expect(JSON.stringify(error)).not.toContain("integration-static-secret");
  });

  it("returns credential-free provider content", async () => {
    await expect(callSharedMcpTool(server, "search", {})).resolves.toEqual({ hits: ["one"] });
  });
});
