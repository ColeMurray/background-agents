import { describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "./mcp-extension";

function harness(result: { content: unknown; truncated: boolean }) {
  const read = vi.fn(async () => ({
    connectionId: "mcpconn_1",
    toolName: "search",
    content: result.content,
    truncated: result.truncated,
  }));
  const extension = createMcpExtension({
    client: {
      read,
      list: async () => ({ grants: [] }),
    },
  });
  const tool = extension.tools?.[0];
  if (!tool) throw new Error("The extension contributes no tool");
  return { tool, read };
}

const api = { callId: "call-1", taskId: 7, conversationId: "conversation-1" } as never;
const context = { abortSignal: undefined } as never;

describe("mcp extension", () => {
  it("asks the owning session to read the reviewed tool", async () => {
    const h = harness({ content: { hits: ["one"] }, truncated: false });

    const output = await h.tool.execute(
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

    const output = await h.tool.execute(
      { connectionId: "mcpconn_1", toolName: "search" },
      api,
      context
    );

    expect(output.details).toMatchObject({ truncated: true });
  });
});
