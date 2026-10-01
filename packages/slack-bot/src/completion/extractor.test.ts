import { describe, expect, it, vi } from "vitest";
import { extractAgentResponse } from "./extractor";
import type { Env } from "../types";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("extractAgentResponse", () => {
  it("uses artifacts API when available", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
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
              createdAt: 10,
            },
            {
              id: "a2",
              type: "branch",
              url: "https://github.com/octocat/repo/pull/new/main...open-inspect%2Fsession-123",
              metadata: { head: "open-inspect/session-123", mode: "manual_pr" },
              createdAt: 11,
            },
          ],
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const env = {
      CONTROL_PLANE: { fetch: fetchMock },
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    const response = await extractAgentResponse(env, "session-1", "msg-1", "C123");

    expect(response.textContent).toBe("Final response");
    expect(response.success).toBe(true);
    for (const [input] of fetchMock.mock.calls) {
      expect(new URL(String(input)).searchParams.get("channel")).toBe("slack:C123");
      expect(new URL(String(input)).searchParams.get("purpose")).toBe("slack-post");
    }
    expect(response.artifacts).toEqual([
      {
        type: "pr",
        url: "https://github.com/octocat/repo/pull/42",
        label: "PR #42",
        metadata: { number: 42 },
      },
      {
        type: "branch",
        url: "https://github.com/octocat/repo/pull/new/main...open-inspect%2Fsession-123",
        label: "Branch: open-inspect/session-123",
        metadata: { head: "open-inspect/session-123", mode: "manual_pr" },
      },
    ]);
  });

  it("rejects instead of falling back to collected events when the artifact read fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
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

    const env = {
      CONTROL_PLANE: { fetch: fetchMock },
      SERVICE_AUTH_SECRET: "test-secret",
    } as unknown as Env;

    await expect(extractAgentResponse(env, "session-2", "msg-2", "C123")).rejects.toThrow();
  });
});
