import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore } from "../db/session-index";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { ActivePromptAuthor } from "../session/active-prompt-author";
import type { Env } from "../types";
import { handleCancelChild, handlePromptChild } from "./session-children";
import type { SessionRouteContext } from "./session-route";
import { routePathPattern } from "../router.test-support";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

vi.mock("../session/integration-settings-resolution", () => ({
  resolveSandboxSettings: vi.fn(),
}));

function routeMatch(path: string, pattern: string): RegExpMatchArray {
  const match = path.match(routePathPattern(pattern));
  if (!match) throw new Error("Expected route match");
  return match;
}

const defaultPromptAuthor: ActivePromptAuthor = {
  userId: "user-1",
  canonicalUserId: "canonical-1",
  scmUserId: null,
  scmLogin: null,
  scmName: null,
  scmEmail: null,
};

function routeContext(
  fetch: SessionRuntimeClient["fetch"],
  promptAuthor = defaultPromptAuthor
): SessionRouteContext {
  return {
    db: {} as SessionRouteContext["db"],
    metrics: {} as SessionRouteContext["metrics"],
    request_id: "request-id",
    trace_id: "trace-id",
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    sessionRuntime: {
      fetch: async (sessionId, path, init, search) => {
        if (sessionId === "parent" && path === "/internal/active-prompt-author") {
          return Response.json(promptAuthor);
        }
        return fetch(sessionId, path, init, search);
      },
    },
  };
}

describe("handlePromptChild", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(resolveSandboxSettings).mockReset();
  });

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
    const childResponse = Response.json({ messageId: "message-1", status: "queued" });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => childResponse);

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
    expect(response).toBe(childResponse);
  });

  it("does not resolve policy or reserve capacity for an active child", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue({
      id: "child",
      parentSessionId: "parent",
      status: "active",
    } as never);
    const reserve = vi.spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease");
    const childResponse = Response.json({ messageId: "message-1", status: "queued" });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => childResponse);

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

    expect(response).toBe(childResponse);
    expect(resolveSandboxSettings).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("accepts the child response when the best-effort message id payload is malformed", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue({
      id: "child",
      parentSessionId: "parent",
      status: "active",
    } as never);
    vi.spyOn(SessionIndexStore.prototype, "touchUpdatedAt").mockResolvedValue(true);
    const childResponse = new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => childResponse);

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

    expect(response).toBe(childResponse);
    expect(response.status).toBe(200);
  });

  it("forwards the parent active prompt author to the child", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue({
      id: "child",
      parentSessionId: "parent",
      status: "active",
    } as never);
    const promptAuthor = {
      userId: "slack:U2",
      canonicalUserId: "canonical-2",
      scmUserId: "222",
      scmLogin: "second-user",
      scmName: "Second User",
      scmEmail: "second@example.com",
    };
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async (sessionId, path, init) => {
      expect(sessionId).toBe("child");
      expect(path).toBe("/internal/parent-prompt");
      const forwarded = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(forwarded).toMatchObject({
        author: {
          userId: "slack:U2",
          canonicalUserId: "canonical-2",
          scmLogin: "second-user",
        },
      });
      expect(forwarded.author).not.toHaveProperty("scmAccessTokenEncrypted");
      return Response.json({ messageId: "message-1", status: "queued" });
    });

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
      routeContext(fetch, promptAuthor)
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
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

  it("releases terminal-child capacity after a definitive child rejection", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "completed",
      } as never)
      .mockResolvedValueOnce({ id: "parent" } as never);
    vi.mocked(resolveSandboxSettings).mockResolvedValue({ maxConcurrentChildSessions: 2 });
    const lease = { token: "lease-1", childSessionId: "child", expiresAt: Date.now() + 60_000 };
    vi.spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease").mockResolvedValue(lease);
    const release = vi
      .spyOn(SessionIndexStore.prototype, "releaseChildAdmissionLease")
      .mockResolvedValue();
    const childResponse = Response.json({ error: "Cannot prompt child" }, { status: 409 });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => childResponse);

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

    expect(response).toBe(childResponse);
    expect(release).toHaveBeenCalledWith(lease);
  });

  it("retains terminal-child capacity when dispatch has an ambiguous transport failure", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "completed",
      } as never)
      .mockResolvedValueOnce({ id: "parent" } as never);
    vi.mocked(resolveSandboxSettings).mockResolvedValue({ maxConcurrentChildSessions: 2 });
    const lease = { token: "lease-1", childSessionId: "child", expiresAt: Date.now() + 60_000 };
    vi.spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease").mockResolvedValue(lease);
    const release = vi
      .spyOn(SessionIndexStore.prototype, "releaseChildAdmissionLease")
      .mockResolvedValue();
    const fetchError = new Error("response lost");
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => {
      throw fetchError;
    });

    await expect(
      handlePromptChild(
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
      )
    ).rejects.toBe(fetchError);

    expect(release).not.toHaveBeenCalled();
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
