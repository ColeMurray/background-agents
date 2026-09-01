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
  it("exposes the complete V1 tool set", async () => {
    const operations = {
      listSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
    };
    const { server, client } = await connectedClient(operations);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(19);
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "environment_get",
      "environment_list",
      "model_list",
      "provider_account_list",
      "repository_list",
      "session_artifacts",
      "session_child_prompt",
      "session_children",
      "session_create",
      "session_diff",
      "session_events",
      "session_get",
      "session_list",
      "session_messages",
      "session_prompt",
      "session_pull_requests",
      "session_stop",
      "session_wait",
      "skill_list",
    ]);
    expect(
      (await client.callTool({ name: "session_list", arguments: { limit: 25, offset: 50 } }))
        .structuredContent
    ).toEqual({
      sessions: [],
      hasMore: false,
    });
    expect(operations.listSessions).toHaveBeenCalledWith({ limit: 25, offset: 50 });
    expect(tools.tools.every((tool) => tool.outputSchema)).toBe(true);
    await Promise.all([client.close(), server.close()]);
  });

  it("rejects ungranted and over-limit path attachments before side effects", async () => {
    const operations = {
      createSession: vi.fn(),
      promptSession: vi.fn(),
      uploadAttachment: vi.fn(),
    };
    const { server, client } = await connectedClient(operations);

    const noRoots = await client.callTool({
      name: "session_create",
      arguments: {
        idempotencyKey: "create-with-file",
        attachmentPaths: ["/tmp/image.png"],
      },
    });
    expect(noRoots.isError).toBe(true);
    expect(operations.createSession).not.toHaveBeenCalled();

    const tooMany = await client.callTool({
      name: "session_prompt",
      arguments: {
        sessionId: "s1",
        clientRequestId: "prompt-with-files",
        attachments: Array.from({ length: 6 }, (_, index) => ({
          attachmentId: `attachment-${index}`,
          name: `${index}.png`,
        })),
        attachmentPaths: ["/tmp/extra.png"],
      },
    });
    expect(tooMany.isError).toBe(true);
    expect(operations.uploadAttachment).not.toHaveBeenCalled();
    expect(operations.promptSession).not.toHaveBeenCalled();
    await Promise.all([client.close(), server.close()]);
  });

  it("accepts valid outputs from both modes of the polymorphic read tools", async () => {
    const artifact = {
      contentType: "image/png",
      contentBase64: "AQI=",
      offset: 0,
      hasMore: false,
    };
    const pullRequest = {
      id: "pr-1",
      provider: "github",
      repoOwner: "open-inspect",
      repoName: "app",
      number: 7,
      url: "https://github.com/open-inspect/app/pull/7",
      state: "open",
      headBranch: "feature",
      baseBranch: "main",
    };
    const child = {
      id: "child-1",
      title: "Child",
      status: "active",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: null,
      repoOwner: "open-inspect",
      repoName: "app",
      environmentId: null,
      parentSessionId: "s1",
      createdAt: 1,
      updatedAt: 2,
    };
    const diff = {
      version: 1,
      current: null,
      lastError: null,
      unavailableReason: null,
      hasMore: false,
    };
    const diffContent = { content: "@@ -1 +1 @@", truncated: false, hasMore: false };
    const operations = {
      artifactContent: vi.fn().mockResolvedValue(artifact),
      artifacts: vi.fn().mockResolvedValue({ artifacts: [], hasMore: false }),
      diff: vi.fn().mockResolvedValue(diff),
      diffFile: vi.fn().mockResolvedValue(diffContent),
      pullRequest: vi.fn().mockResolvedValue(pullRequest),
      pullRequests: vi.fn().mockResolvedValue({ pullRequests: [], hasMore: false }),
      child: vi.fn().mockResolvedValue(child),
      children: vi.fn().mockResolvedValue({ children: [], hasMore: false }),
    };
    const { server, client } = await connectedClient(operations);

    await expect(
      client.callTool({
        name: "session_artifacts",
        arguments: { sessionId: "s1", artifactId: "artifact-1" },
      })
    ).resolves.toMatchObject({ structuredContent: artifact });
    await expect(
      client.callTool({
        name: "session_pull_requests",
        arguments: { sessionId: "s1", pullRequestId: "pr-1" },
      })
    ).resolves.toMatchObject({ structuredContent: pullRequest });
    await expect(
      client.callTool({ name: "session_artifacts", arguments: { sessionId: "s1" } })
    ).resolves.toMatchObject({ structuredContent: { artifacts: [], hasMore: false } });
    await expect(
      client.callTool({ name: "session_diff", arguments: { sessionId: "s1" } })
    ).resolves.toMatchObject({ structuredContent: diff });
    await expect(
      client.callTool({
        name: "session_diff",
        arguments: { sessionId: "s1", revisionId: "r1", fileId: "f1" },
      })
    ).resolves.toMatchObject({ structuredContent: diffContent });
    await expect(
      client.callTool({ name: "session_pull_requests", arguments: { sessionId: "s1" } })
    ).resolves.toMatchObject({ structuredContent: { pullRequests: [], hasMore: false } });
    await expect(
      client.callTool({ name: "session_children", arguments: { sessionId: "s1" } })
    ).resolves.toMatchObject({ structuredContent: { children: [], hasMore: false } });
    await expect(
      client.callTool({
        name: "session_children",
        arguments: { sessionId: "s1", childId: "child-1" },
      })
    ).resolves.toMatchObject({ structuredContent: child });
    expect(operations.artifactContent).toHaveBeenCalledWith("s1", "artifact-1", {
      offset: undefined,
      limit: undefined,
    });
    expect(operations.pullRequest).toHaveBeenCalledWith("s1", "pr-1");
    await Promise.all([client.close(), server.close()]);
  });

  it("rejects empty and mixed polymorphic outputs", async () => {
    const pullRequest = {
      id: "pr-1",
      provider: "github",
      repoOwner: "open-inspect",
      repoName: "app",
      number: 7,
      url: "https://github.com/open-inspect/app/pull/7",
      state: "open",
      headBranch: "feature",
      baseBranch: "main",
    };
    const child = {
      id: "child-1",
      title: null,
      status: "active",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: null,
      repoOwner: null,
      repoName: null,
      environmentId: null,
      parentSessionId: "s1",
      createdAt: 1,
      updatedAt: 2,
    };
    const operations = {
      artifacts: vi.fn().mockResolvedValue({}),
      artifactContent: vi.fn().mockResolvedValue({
        artifacts: [],
        contentType: "image/png",
        contentBase64: "AQI=",
        offset: 0,
        hasMore: false,
      }),
      diff: vi.fn().mockResolvedValue({}),
      diffFile: vi.fn().mockResolvedValue({
        version: 1,
        current: null,
        lastError: null,
        unavailableReason: null,
        content: "patch",
        truncated: false,
        hasMore: false,
      }),
      pullRequests: vi.fn().mockResolvedValue({}),
      pullRequest: vi.fn().mockResolvedValue({ ...pullRequest, pullRequests: [], hasMore: false }),
      children: vi.fn().mockResolvedValue({}),
      child: vi.fn().mockResolvedValue({ ...child, children: [], hasMore: false }),
    };
    const { server, client } = await connectedClient(operations);

    const results = await Promise.all([
      client.callTool({ name: "session_artifacts", arguments: { sessionId: "s1" } }),
      client.callTool({
        name: "session_artifacts",
        arguments: { sessionId: "s1", artifactId: "artifact-1" },
      }),
      client.callTool({ name: "session_diff", arguments: { sessionId: "s1" } }),
      client.callTool({
        name: "session_diff",
        arguments: { sessionId: "s1", revisionId: "r1", fileId: "f1" },
      }),
      client.callTool({ name: "session_pull_requests", arguments: { sessionId: "s1" } }),
      client.callTool({
        name: "session_pull_requests",
        arguments: { sessionId: "s1", pullRequestId: "pr-1" },
      }),
      client.callTool({ name: "session_children", arguments: { sessionId: "s1" } }),
      client.callTool({
        name: "session_children",
        arguments: { sessionId: "s1", childId: "child-1" },
      }),
    ]);

    expect(results.every((result) => result.isError)).toBe(true);
    await Promise.all([client.close(), server.close()]);
  });

  it("requires and preserves retry identifiers for create and prompt tools", async () => {
    const operations = {
      createSession: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "s1", status: "created" })
        .mockResolvedValueOnce({ sessionId: "s2", messageId: "m2", status: "queued" }),
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
    const created = await client.callTool({
      name: "session_create",
      arguments: {
        title: "T",
        model: "openai/gpt-5.6-sol",
        idempotencyKey: "retry-create",
      },
    });
    const queued = await client.callTool({
      name: "session_create",
      arguments: {
        title: "Queued",
        model: "openai/gpt-5.6-sol",
        idempotencyKey: "retry-create-queued",
      },
    });
    await client.callTool({
      name: "session_prompt",
      arguments: { sessionId: "s1", content: "P", clientRequestId: "retry-prompt" },
    });

    expect(operations.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ reasoningEffort: expect.anything() })
    );
    expect(created.structuredContent).toEqual({ sessionId: "s1", status: "created" });
    expect(queued.structuredContent).toEqual({
      sessionId: "s2",
      messageId: "m2",
      status: "queued",
    });
    expect(operations.promptSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ clientRequestId: "retry-prompt" })
    );
    await Promise.all([client.close(), server.close()]);
  });

  it("rejects incoherent session create outputs", async () => {
    const operations = {
      createSession: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "s1", status: "queued" })
        .mockResolvedValueOnce({ sessionId: "s2", messageId: "m2", status: "created" }),
    };
    const { server, client } = await connectedClient(operations);

    const missingMessage = await client.callTool({
      name: "session_create",
      arguments: { idempotencyKey: "missing-message" },
    });
    const impossibleMessage = await client.callTool({
      name: "session_create",
      arguments: { idempotencyKey: "impossible-message" },
    });

    expect(missingMessage.isError).toBe(true);
    expect(impossibleMessage.isError).toBe(true);
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
        error: { code: "unauthenticated", message: "Authentication required", status: 401 },
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
      structuredContent: { error: { code: "service_unavailable" } },
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
