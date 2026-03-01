import { describe, expect, it, vi } from "vitest";
import { extractAgentResponse, SUMMARY_TOOL_NAMES } from "./extractor";
import type { Env } from "../types";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createMockEnv(fetchImpl: (url: string | URL | Request) => Promise<Response>): Env {
  return {
    CONTROL_PLANE: { fetch: vi.fn(fetchImpl) },
  } as unknown as Env;
}

describe("extractAgentResponse", () => {
  it("extracts text, artifacts, and success from events and artifacts API", async () => {
    const env = createMockEnv(async (input) => {
      const url = String(input);
      if (url.includes("/events")) {
        return jsonResponse({
          events: [
            {
              id: "evt-token",
              type: "token",
              data: { content: "Final response" },
              messageId: "msg-1",
              createdAt: 10,
            },
            {
              id: "evt-complete",
              type: "execution_complete",
              data: { success: true },
              messageId: "msg-1",
              createdAt: 11,
            },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/artifacts")) {
        return jsonResponse({
          artifacts: [
            {
              id: "a1",
              type: "pr",
              url: "https://github.com/octocat/repo/pull/42",
              metadata: { number: 42 },
              createdAt: 1,
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const response = await extractAgentResponse(env, "session-1", "msg-1");

    expect(response.textContent).toBe("Final response");
    expect(response.success).toBe(true);
    expect(response.artifacts).toEqual([
      {
        type: "pr",
        url: "https://github.com/octocat/repo/pull/42",
        label: "PR #42",
        metadata: { number: 42 },
      },
    ]);
  });

  it("falls back to event artifacts when artifacts API errors", async () => {
    const env = createMockEnv(async (input) => {
      const url = String(input);
      if (url.includes("/events")) {
        return jsonResponse({
          events: [
            {
              id: "evt-artifact",
              type: "artifact",
              data: {
                artifactType: "branch",
                url: "https://github.com/octocat/repo/tree/feature",
                metadata: { name: "feature" },
              },
              messageId: "msg-2",
              createdAt: 20,
            },
            {
              id: "evt-complete",
              type: "execution_complete",
              data: { success: true },
              messageId: "msg-2",
              createdAt: 21,
            },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/artifacts")) {
        return jsonResponse({ error: "failed" }, 500);
      }
      return new Response("Not found", { status: 404 });
    });

    const response = await extractAgentResponse(env, "session-2", "msg-2");

    expect(response.artifacts).toEqual([
      {
        type: "branch",
        url: "https://github.com/octocat/repo/tree/feature",
        label: "Branch: feature",
      },
    ]);
  });

  it("returns empty response on events API failure", async () => {
    const env = createMockEnv(async () => {
      return jsonResponse({ error: "server error" }, 500);
    });

    const response = await extractAgentResponse(env, "session-3", "msg-3");

    expect(response.textContent).toBe("");
    expect(response.toolCalls).toEqual([]);
    expect(response.artifacts).toEqual([]);
    expect(response.success).toBe(false);
  });

  it("returns empty response on fetch exception", async () => {
    const env = createMockEnv(async () => {
      throw new Error("Network error");
    });

    const response = await extractAgentResponse(env, "session-4", "msg-4");

    expect(response.textContent).toBe("");
    expect(response.success).toBe(false);
  });

  it("extracts tool call summaries", async () => {
    const env = createMockEnv(async (input) => {
      const url = String(input);
      if (url.includes("/events")) {
        return jsonResponse({
          events: [
            {
              id: "tc-1",
              type: "tool_call",
              data: { tool: "Read", args: { file_path: "src/index.ts" } },
              messageId: "msg-5",
              createdAt: 1,
            },
            {
              id: "tc-2",
              type: "tool_call",
              data: { tool: "Edit", args: { file_path: "src/main.ts" } },
              messageId: "msg-5",
              createdAt: 2,
            },
            {
              id: "tc-3",
              type: "tool_call",
              data: { tool: "Bash", args: { command: "npm run build && npm test" } },
              messageId: "msg-5",
              createdAt: 3,
            },
            {
              id: "tc-4",
              type: "tool_call",
              data: { tool: "Grep", args: { pattern: "TODO" } },
              messageId: "msg-5",
              createdAt: 4,
            },
            {
              id: "tc-5",
              type: "tool_call",
              data: { tool: "Write", args: { file_path: "new-file.ts" } },
              messageId: "msg-5",
              createdAt: 5,
            },
            {
              id: "tc-6",
              type: "tool_call",
              data: { tool: "CustomTool", args: {} },
              messageId: "msg-5",
              createdAt: 6,
            },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/artifacts")) {
        return jsonResponse({ artifacts: [] });
      }
      return new Response("Not found", { status: 404 });
    });

    const response = await extractAgentResponse(env, "session-5", "msg-5");

    expect(response.toolCalls).toEqual([
      { tool: "Read", summary: "Read src/index.ts" },
      { tool: "Edit", summary: "Edited src/main.ts" },
      { tool: "Bash", summary: "Ran: npm run build && npm test" },
      { tool: "Grep", summary: 'Searched for "TODO"' },
      { tool: "Write", summary: "Created new-file.ts" },
      { tool: "CustomTool", summary: "Used CustomTool" },
    ]);
  });

  it("paginates events with cursor", async () => {
    let callCount = 0;
    const env = createMockEnv(async (input) => {
      const url = String(input);
      if (url.includes("/events")) {
        callCount++;
        if (callCount === 1) {
          return jsonResponse({
            events: [
              {
                id: "evt-1",
                type: "token",
                data: { content: "partial" },
                messageId: "msg-6",
                createdAt: 1,
              },
            ],
            hasMore: true,
            cursor: "cursor-1",
          });
        }
        return jsonResponse({
          events: [
            {
              id: "evt-2",
              type: "token",
              data: { content: "Final answer" },
              messageId: "msg-6",
              createdAt: 2,
            },
            {
              id: "evt-complete",
              type: "execution_complete",
              data: { success: true },
              messageId: "msg-6",
              createdAt: 3,
            },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/artifacts")) {
        return jsonResponse({ artifacts: [] });
      }
      return new Response("Not found", { status: 404 });
    });

    const response = await extractAgentResponse(env, "session-6", "msg-6");

    // Should use the last token event's content
    expect(response.textContent).toBe("Final answer");
    expect(response.success).toBe(true);
    expect(callCount).toBe(2);
  });

  it("uses last token event by createdAt for textContent", async () => {
    const env = createMockEnv(async (input) => {
      const url = String(input);
      if (url.includes("/events")) {
        return jsonResponse({
          events: [
            {
              id: "evt-t2",
              type: "token",
              data: { content: "Second thought" },
              messageId: "msg-7",
              createdAt: 20,
            },
            {
              id: "evt-t1",
              type: "token",
              data: { content: "First thought" },
              messageId: "msg-7",
              createdAt: 10,
            },
            {
              id: "evt-t3",
              type: "token",
              data: { content: "Final answer" },
              messageId: "msg-7",
              createdAt: 30,
            },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/artifacts")) {
        return jsonResponse({ artifacts: [] });
      }
      return new Response("Not found", { status: 404 });
    });

    const response = await extractAgentResponse(env, "session-7", "msg-7");

    expect(response.textContent).toBe("Final answer");
  });

  it("exports SUMMARY_TOOL_NAMES constant", () => {
    expect(SUMMARY_TOOL_NAMES).toContain("Edit");
    expect(SUMMARY_TOOL_NAMES).toContain("Write");
    expect(SUMMARY_TOOL_NAMES).toContain("Bash");
    expect(SUMMARY_TOOL_NAMES).toContain("Grep");
    expect(SUMMARY_TOOL_NAMES).toContain("Read");
  });

  it("truncates long Bash commands at 40 chars", async () => {
    const longCommand = "a".repeat(50);
    const env = createMockEnv(async (input) => {
      const url = String(input);
      if (url.includes("/events")) {
        return jsonResponse({
          events: [
            {
              id: "tc-bash",
              type: "tool_call",
              data: { tool: "Bash", args: { command: longCommand } },
              messageId: "msg-8",
              createdAt: 1,
            },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/artifacts")) {
        return jsonResponse({ artifacts: [] });
      }
      return new Response("Not found", { status: 404 });
    });

    const response = await extractAgentResponse(env, "session-8", "msg-8");

    expect(response.toolCalls[0].summary).toBe(`Ran: ${"a".repeat(40)}...`);
  });

  it("labels branch artifacts from artifacts API using head metadata", async () => {
    const env = createMockEnv(async (input) => {
      const url = String(input);
      if (url.includes("/events")) {
        return jsonResponse({ events: [], hasMore: false });
      }
      if (url.includes("/artifacts")) {
        return jsonResponse({
          artifacts: [
            {
              id: "a1",
              type: "branch",
              url: "https://github.com/octocat/repo/tree/my-branch",
              metadata: { head: "my-branch" },
              createdAt: 1,
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const response = await extractAgentResponse(env, "session-9", "msg-9");

    expect(response.artifacts[0].label).toBe("Branch: my-branch");
  });
});
