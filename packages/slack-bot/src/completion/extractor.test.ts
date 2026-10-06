import { describe, expect, it, vi } from "vitest";
import { extractAgentResponse } from "./extractor";
import type { Env } from "../types";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("extractAgentResponse", () => {
  it("scopes event and artifact reads to the Slack destination and purpose", async () => {
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
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/sessions/session-1/events",
      "/sessions/session-1/artifacts",
    ]);
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
    ]);
  });
});
