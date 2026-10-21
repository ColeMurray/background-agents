import { describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "./mcp-extension";

type McpReadRequest = {
  connectionId?: string;
  serverId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

function harness(result: { content: unknown; truncated: boolean }) {
  const read = vi.fn(
    async (
      _request: McpReadRequest,
      _signal?: AbortSignal
    ): Promise<{
      connectionId?: string;
      serverId?: string;
      toolName: string;
      content: unknown;
      truncated: boolean;
    }> => ({
      connectionId: "mcpconn_1",
      toolName: "search",
      content: result.content,
      truncated: result.truncated,
    })
  );
  const extension = createMcpExtension({
    client: {
      read,
      list: async () => ({ grants: [], shared: [] }),
    },
  });
  const tools = extension.tools ?? [];
  const shared = tools.find((tool) => tool.name === "mcp_read_shared");
  const connection = tools.find((tool) => tool.name === "mcp_read_connection");
  if (!shared || !connection) throw new Error("The extension contributes no MCP read tools");
  return { shared, connection, read };
}

const api = { callId: "call-1", taskId: 7, conversationId: "conversation-1" } as never;
const context = { abortSignal: undefined } as never;

describe("mcp extension", () => {
  it("asks the owning session to read the reviewed tool", async () => {
    const h = harness({ content: { hits: ["one"] }, truncated: false });

    const output = await h.connection.execute(
      { connectionId: "mcpconn_1", toolName: "search", arguments: { query: "x" } },
      api,
      context
    );

    expect(output.isError).toBe(false);
    expect(h.read).toHaveBeenCalledWith(
      {
        connectionId: "mcpconn_1",
        toolName: "search",
        arguments: { query: "x" },
      },
      undefined
    );
    expect(JSON.stringify(output.output)).toContain("hits");
  });

  it("states that a result was cut", async () => {
    const h = harness({ content: { preview: "…" }, truncated: true });

    const output = await h.connection.execute(
      { connectionId: "mcpconn_1", toolName: "search" },
      api,
      context
    );

    expect(output.details).toMatchObject({ truncated: true });
  });

  it("keeps the shared lane and the personal lane in separate tools", async () => {
    const h = harness({ content: { hits: ["one"] }, truncated: false });

    await h.shared.execute({ serverId: "srv_1", toolName: "search" }, api, context);

    expect(h.read).toHaveBeenCalledWith(
      { serverId: "srv_1", toolName: "search", arguments: {} },
      undefined
    );
    // The shared lane never names a connection, and the personal lane never
    // names a server: exactly one target, at the tool boundary.
    expect(h.read.mock.calls[0]?.[0]).not.toHaveProperty("connectionId");
  });

  it("names exactly one target in each tool's parameters", () => {
    const h = harness({ content: {}, truncated: false });

    const shared = h.shared.parameters as unknown as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const connection = h.connection.parameters as unknown as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(shared.properties)).toEqual(["serverId", "toolName", "arguments"]);
    expect(shared.required).toEqual(["serverId", "toolName"]);
    expect(Object.keys(connection.properties)).toEqual(["connectionId", "toolName", "arguments"]);
    expect(connection.required).toEqual(["connectionId", "toolName"]);
  });
});
