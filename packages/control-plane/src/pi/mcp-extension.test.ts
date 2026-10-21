import { describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "./mcp-extension";

type McpReadRequest = {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

function harness(result: { content: unknown; truncated: boolean }) {
  const read = vi.fn(
    async (
      _request: McpReadRequest,
      _signal?: AbortSignal
    ): Promise<{
      serverId: string;
      toolName: string;
      content: unknown;
      truncated: boolean;
    }> => ({
      serverId: "mcpsrv_1",
      toolName: "search",
      content: result.content,
      truncated: result.truncated,
    })
  );
  const extension = createMcpExtension({
    client: {
      read,
      list: async () => ({ shared: [] }),
    },
  });
  const tools = extension.tools ?? [];
  const shared = tools.find((tool) => tool.name === "mcp_read_shared");
  if (!shared) throw new Error("The extension contributes no MCP read tools");
  return { shared, read };
}

const api = { callId: "call-1", taskId: 7, conversationId: "conversation-1" } as never;
const context = { abortSignal: undefined } as never;

describe("mcp extension", () => {
  it("asks the owning session to read the reviewed tool", async () => {
    const h = harness({ content: { hits: ["one"] }, truncated: false });

    const output = await h.shared.execute(
      { serverId: "mcpsrv_1", toolName: "search", arguments: { query: "x" } },
      api,
      context
    );

    expect(output.isError).toBe(false);
    expect(h.read).toHaveBeenCalledWith(
      {
        serverId: "mcpsrv_1",
        toolName: "search",
        arguments: { query: "x" },
      },
      undefined
    );
    expect(JSON.stringify(output.output)).toContain("hits");
  });

  it("states that a result was cut", async () => {
    const h = harness({ content: { preview: "…" }, truncated: true });

    const output = await h.shared.execute(
      { serverId: "mcpsrv_1", toolName: "search" },
      api,
      context
    );

    expect(output.details).toMatchObject({ truncated: true });
  });

  it("names exactly one target in its parameters", () => {
    const h = harness({ content: {}, truncated: false });

    const shared = h.shared.parameters as unknown as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(shared.properties)).toEqual(["serverId", "toolName", "arguments"]);
    expect(shared.required).toEqual(["serverId", "toolName"]);
  });

  it("contributes no personal-connection tool", () => {
    const h = harness({ content: {}, truncated: false });

    expect((h.shared as { name: string }).name).toBe("mcp_read_shared");
    const properties = (h.shared.parameters as unknown as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties)).not.toContain("connectionId");
  });
});
