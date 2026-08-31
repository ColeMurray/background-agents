import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { CliError } from "./errors.js";
import { createMcpServer, MAX_MCP_RESULT_BYTES, toolResult } from "./mcp-server.js";

async function connectedClient(operations: object) {
  const server = createMcpServer(operations as never);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("MCP server", () => {
  it("exposes only Increment 1 session tools", async () => {
    const operations = {
      listSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
    };
    const { server, client } = await connectedClient(operations);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "session_create",
      "session_events",
      "session_get",
      "session_list",
      "session_prompt",
      "session_stop",
      "session_wait",
    ]);
    expect(tools.tools.some((tool) => /attachment|target/.test(tool.name))).toBe(false);
    expect(
      (await client.callTool({ name: "session_list", arguments: { limit: 25, offset: 50 } }))
        .structuredContent
    ).toEqual({
      sessions: [],
      hasMore: false,
    });
    expect(operations.listSessions).toHaveBeenCalledWith({ limit: 25, offset: 50 });
    await Promise.all([client.close(), server.close()]);
  });

  it("requires and preserves retry identifiers for create and prompt tools", async () => {
    const operations = {
      createSession: vi.fn().mockResolvedValue({ sessionId: "s1", status: "created" }),
      promptSession: vi.fn().mockResolvedValue({ messageId: "m1", status: "queued" }),
    };
    const { server, client } = await connectedClient(operations);

    const invalidCreate = await client.callTool({
      name: "session_create",
      arguments: { title: "T", model: "model", reasoningEffort: "high" },
    });
    const invalidPrompt = await client.callTool({
      name: "session_prompt",
      arguments: { sessionId: "s1", content: "P" },
    });
    expect(invalidCreate.isError).toBe(true);
    expect(invalidPrompt.isError).toBe(true);
    expect(operations.createSession).not.toHaveBeenCalled();
    expect(operations.promptSession).not.toHaveBeenCalled();
    await client.callTool({
      name: "session_create",
      arguments: {
        title: "T",
        model: "openai/gpt-5.6-sol",
        idempotencyKey: "retry-create",
      },
    });
    await client.callTool({
      name: "session_prompt",
      arguments: { sessionId: "s1", content: "P", clientRequestId: "retry-prompt" },
    });

    expect(operations.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ reasoningEffort: expect.anything() })
    );
    expect(operations.promptSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ clientRequestId: "retry-prompt" })
    );
    await Promise.all([client.close(), server.close()]);
  });

  it("rejects session list pagination outside the shared bounds", async () => {
    const operations = { listSessions: vi.fn() };
    const { server, client } = await connectedClient(operations);

    const result = await client.callTool({
      name: "session_list",
      arguments: { limit: 201, offset: -1 },
    });

    expect(result.isError).toBe(true);
    expect(operations.listSessions).not.toHaveBeenCalled();
    await Promise.all([client.close(), server.close()]);
  });

  it("returns centralized MCP error details", async () => {
    const { server, client } = await connectedClient({
      listSessions: vi.fn().mockRejectedValue(new CliError("auth", "Authentication required", 401)),
    });
    const result = await client.callTool({ name: "session_list", arguments: {} });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { kind: "auth", message: "Authentication required", status: 401 },
      },
    });
    await Promise.all([client.close(), server.close()]);
  });

  it("forwards ordered event journal queries and tombstones", async () => {
    const page = {
      changes: [{ kind: "delete", revision: 8, eventId: "old-name" }],
      checkpoint: 8,
      hasMore: false,
    };
    const operations = { events: vi.fn().mockResolvedValue(page) };
    const { server, client } = await connectedClient(operations);
    const result = await client.callTool({
      name: "session_events",
      arguments: { sessionId: "s1", after: 7, limit: 50 },
    });
    expect(operations.events).toHaveBeenCalledWith("s1", { after: 7, limit: 50 });
    expect(result.structuredContent).toEqual(page);
    await Promise.all([client.close(), server.close()]);
  });

  it("rejects wait timeouts above five minutes before dispatch", async () => {
    const operations = { wait: vi.fn() };
    const { server, client } = await connectedClient(operations);
    const result = await client.callTool({
      name: "session_wait",
      arguments: { sessionId: "s1", timeoutMs: 300_001 },
    });
    expect(result.isError).toBe(true);
    expect(operations.wait).not.toHaveBeenCalled();
    await Promise.all([client.close(), server.close()]);
  });

  it("returns typed isError before constructing an oversized MCP result", async () => {
    const { server, client } = await connectedClient({
      listSessions: vi.fn().mockResolvedValue({ value: "x".repeat(1024 * 1024) }),
    });
    const result = await client.callTool({ name: "session_list", arguments: {} });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { kind: "service" } },
    });
    expect(JSON.stringify(result)).not.toContain("xxx");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_MCP_RESULT_BYTES);
    await Promise.all([client.close(), server.close()]);
  });

  it("accepts an exact 1 MiB final result envelope and rejects one additional byte", () => {
    const emptyEnvelopeBytes = Buffer.byteLength(
      JSON.stringify({ content: [], structuredContent: { value: "" } })
    );
    const exact = toolResult({ value: "x".repeat(MAX_MCP_RESULT_BYTES - emptyEnvelopeBytes) });
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(MAX_MCP_RESULT_BYTES);
    expect(() =>
      toolResult({ value: "x".repeat(MAX_MCP_RESULT_BYTES - emptyEnvelopeBytes + 1) })
    ).toThrow("exceeded");
  });
});
