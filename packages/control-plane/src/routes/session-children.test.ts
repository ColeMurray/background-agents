import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore } from "../db/session-index";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { handleCancelChild, handlePromptChild } from "./session-children";
import type { SessionRouteContext } from "./session-route";
import { parsePattern } from "./shared";

vi.mock("../session/integration-settings-resolution", () => ({
  resolveSandboxSettings: vi.fn(),
}));

function routeMatch(path: string, pattern: string): RegExpMatchArray {
  const match = path.match(parsePattern(pattern));
  if (!match) throw new Error("Expected route match");
  return match;
}

function routeContext(fetch: SessionRuntimeClient["fetch"]): SessionRouteContext {
  return {
    db: {} as SessionRouteContext["db"],
    metrics: {} as SessionRouteContext["metrics"],
    request_id: "request-id",
    trace_id: "trace-id",
    sessionRuntime: { fetch },
  };
}

describe("handlePromptChild", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reserves terminal-child capacity from parent policy for child-owned finalization", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "completed",
      } as never)
      .mockResolvedValueOnce({
        id: "parent",
        repoOwner: "acme",
        repoName: "repo",
        environmentId: "env-1",
      } as never);
    vi.mocked(resolveSandboxSettings).mockResolvedValue({ maxConcurrentChildSessions: 2 });
    const lease = { token: "lease-1", childSessionId: "child", expiresAt: Date.now() + 60_000 };
    const reserve = vi
      .spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease")
      .mockResolvedValue(lease);
    const release = vi
      .spyOn(SessionIndexStore.prototype, "releaseChildAdmissionLease")
      .mockResolvedValue();
    vi.spyOn(SessionIndexStore.prototype, "touchUpdatedAt").mockResolvedValue(true);
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ messageId: "message-1", status: "queued" })
    );

    const response = await handlePromptChild(
      new Request("https://test.local/sessions/parent/children/child/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Continue" }),
      }),
      {} as Env,
      routeMatch(
        "/sessions/parent/children/child/prompt",
        "/sessions/:id/children/:childId/prompt"
      ),
      routeContext(fetch)
    );

    expect(response.status).toBe(200);
    expect(resolveSandboxSettings).toHaveBeenCalledWith(expect.anything(), "acme", "repo", "env-1");
    expect(reserve).toHaveBeenCalledWith("parent", "child", 2);
    expect(release).not.toHaveBeenCalled();
  });

  it("rejects a terminal-child resume when the parent has no capacity", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "failed",
      } as never)
      .mockResolvedValueOnce({ id: "parent" } as never);
    vi.mocked(resolveSandboxSettings).mockResolvedValue({ maxConcurrentChildSessions: 1 });
    vi.spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease").mockResolvedValue(null);
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>();

    const response = await handlePromptChild(
      new Request("https://test.local/sessions/parent/children/child/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Continue" }),
      }),
      {} as Env,
      routeMatch(
        "/sessions/parent/children/child/prompt",
        "/sessions/:id/children/:childId/prompt"
      ),
      routeContext(fetch)
    );

    expect(response.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("handleCancelChild", () => {
  afterEach(() => vi.restoreAllMocks());

  it("attempts every descendant and aggregates non-conflict failures", async () => {
    vi.spyOn(SessionIndexStore.prototype, "isChildOf").mockResolvedValue(true);
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockResolvedValue([
      "deep-failure",
      "later-success",
      "shallow-failure",
    ]);

    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async (sessionId) => {
      if (sessionId === "child") return Response.json({ status: "cancelled" });
      if (sessionId === "deep-failure" || sessionId === "shallow-failure") {
        return Response.json({ error: "failure" }, { status: 500 });
      }
      return Response.json({ status: "cancelled" });
    });
    const match = routeMatch(
      "/sessions/parent/children/child/cancel",
      "/sessions/:id/children/:childId/cancel"
    );

    const response = await handleCancelChild(
      new Request("https://test.local/sessions/parent/children/child/cancel", { method: "POST" }),
      {} as Env,
      match,
      routeContext(fetch)
    );

    expect(fetch.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "child",
      "deep-failure",
      "later-success",
      "shallow-failure",
    ]);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Nested tasks could not be cancelled: deep-failure, shallow-failure",
      cancelledDescendantIds: ["later-success"],
    });
  });
});
