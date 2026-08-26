import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIndexRoutes } from "./session-index";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import type { Principal } from "../auth/principal";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

const mockSessionIndexStore = {
  list: vi.fn(),
  delete: vi.fn(),
  getVisibleForUser: vi.fn(),
  updateReadState: vi.fn(),
};

vi.mock("../db/session-index", () => ({
  SessionIndexStore: vi.fn().mockImplementation(function () {
    return mockSessionIndexStore;
  }),
}));

function createCtx(principal?: Principal): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db: {} as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
    principal,
  };
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
  } as Env;
}

function getHandler(method: string, path: string) {
  for (const route of sessionIndexRoutes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return { handler: route.handler, match };
  }
  throw new Error(`No route found for ${method} ${path}`);
}

async function listSessions(query = "", principal?: Principal): Promise<Response> {
  const { handler, match } = getHandler("GET", "/sessions");
  return handler(
    new Request(`https://test.local/sessions${query}`),
    createEnv(),
    match,
    createCtx(principal)
  );
}

async function patchReadState(
  body: string,
  principal?: Principal,
  matchOverride?: RegExpMatchArray
): Promise<Response> {
  const { handler, match } = getHandler("PATCH", "/sessions/session-1/read-state");
  return handler(
    new Request("https://test.local/sessions/session-1/read-state", {
      method: "PATCH",
      body,
    }),
    createEnv(),
    matchOverride ?? match,
    createCtx(principal)
  );
}

describe("session index routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionIndexStore.list.mockResolvedValue({
      sessions: [],
      hasMore: false,
    });
    mockSessionIndexStore.getVisibleForUser.mockResolvedValue({ id: "session-1" });
    mockSessionIndexStore.updateReadState.mockResolvedValue({
      sessionId: "session-1",
      outcome: "marked_read",
      unread: false,
      latestMessageId: "message-1",
    });
  });

  it("defaults invalid pagination values before querying the store", async () => {
    const response = await listSessions("?limit=abc&offset=nope");

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      excludeAutomationLineage: false,
      createdByUserIds: [],
      limit: 50,
      offset: 0,
    });
  });

  it("clamps pagination values before querying the store", async () => {
    const response = await listSessions("?limit=500&offset=-10");

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      excludeAutomationLineage: false,
      createdByUserIds: [],
      limit: 100,
      offset: 0,
    });
  });

  it("passes validated status filters through to the store", async () => {
    const response = await listSessions("?status=active&excludeStatus=archived");

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", excludeStatus: "archived" })
    );
  });

  it.each([
    ["?status=unknown", "Invalid status"],
    ["?excludeStatus=unknown", "Invalid excludeStatus"],
  ])("rejects invalid status filters before querying the store", async (query, message) => {
    const response = await listSessions(query);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(mockSessionIndexStore.list).not.toHaveBeenCalled();
  });

  it("passes validated creator filters through to the store", async () => {
    const response = await listSessions(
      "?createdBy=0123456789abcdef0123456789abcdef&createdBy=0123456789abcdef0123456789abcdef"
    );

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      excludeAutomationLineage: false,
      createdByUserIds: ["0123456789abcdef0123456789abcdef"],
      limit: 50,
      offset: 0,
    });
  });

  it("resolves createdBy=me from the authenticated user principal", async () => {
    const response = await listSessions("?createdBy=me", {
      kind: "user",
      userId: "0123456789abcdef0123456789abcdef",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      excludeAutomationLineage: false,
      createdByUserIds: ["0123456789abcdef0123456789abcdef"],
      limit: 50,
      offset: 0,
      viewerUserId: "0123456789abcdef0123456789abcdef",
    });
  });

  it("does not mark service session lists as private viewer data", async () => {
    const response = await listSessions("", {
      kind: "service",
      service: "linear-bot",
      actor: null,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBeNull();
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith(
      expect.not.objectContaining({ viewerUserId: expect.anything() })
    );
  });

  it("passes the automation-lineage exclusion through to the store", async () => {
    const response = await listSessions("?excludeAutomationLineage=true");

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith(
      expect.objectContaining({ excludeAutomationLineage: true })
    );
  });

  it("rejects an invalid automation-lineage exclusion before querying the store", async () => {
    const response = await listSessions("?excludeAutomationLineage=unknown");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid excludeAutomationLineage" });
    expect(mockSessionIndexStore.list).not.toHaveBeenCalled();
  });

  it("preserves mixed creator filters as OR inputs", async () => {
    const response = await listSessions(
      "?createdBy=ffffffffffffffffffffffffffffffff&createdBy=me",
      { kind: "user", userId: "0123456789abcdef0123456789abcdef" }
    );

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByUserIds: ["ffffffffffffffffffffffffffffffff", "0123456789abcdef0123456789abcdef"],
      })
    );
  });

  it("deduplicates creator filters after resolving createdBy=me", async () => {
    const response = await listSessions(
      "?createdBy=0123456789abcdef0123456789abcdef&createdBy=me&createdBy=me",
      { kind: "user", userId: "0123456789abcdef0123456789abcdef" }
    );

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByUserIds: ["0123456789abcdef0123456789abcdef"],
      })
    );
  });

  it("rejects invalid creator filters before querying the store", async () => {
    const response = await listSessions("?createdBy=not-a-user-id", {
      kind: "user",
      userId: "0123456789abcdef0123456789abcdef",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid createdBy" });
    expect(mockSessionIndexStore.list).not.toHaveBeenCalled();
  });

  it.each<Principal>([
    { kind: "service", service: "linear-bot", actor: null },
    { kind: "sandbox", sessionId: "session-1" },
  ])("rejects createdBy=me for a $kind principal", async (principal) => {
    const response = await listSessions("?createdBy=me", principal);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid createdBy" });
    expect(mockSessionIndexStore.list).not.toHaveBeenCalled();
  });

  it("rejects createdBy=me for a non-canonical user principal", async () => {
    const response = await listSessions("?createdBy=me", {
      kind: "user",
      userId: "not-canonical",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid createdBy" });
    expect(mockSessionIndexStore.list).not.toHaveBeenCalled();
  });

  it("requires a session ID for read-state mutations", async () => {
    const { match } = getHandler("PATCH", "/sessions/session-1/read-state");
    const response = await patchReadState(
      JSON.stringify({ action: "mark_latest_message_read" }),
      { kind: "user", userId: "user-1" },
      Object.assign(match, { groups: {} })
    );

    expect(response.status).toBe(400);
    expect(mockSessionIndexStore.updateReadState).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{"],
    ["an invalid action", JSON.stringify({ action: "mark_latest_message_read", userId: "user-2" })],
  ])("rejects %s for read-state mutations", async (_description, body) => {
    const response = await patchReadState(body, {
      kind: "user",
      userId: "user-1",
    });

    expect(response.status).toBe(400);
    expect(mockSessionIndexStore.updateReadState).not.toHaveBeenCalled();
  });

  it("does not expose invisible sessions through read-state mutations", async () => {
    mockSessionIndexStore.getVisibleForUser.mockResolvedValue(null);

    const response = await patchReadState(JSON.stringify({ action: "mark_latest_message_read" }), {
      kind: "user",
      userId: "user-1",
    });

    expect(response.status).toBe(404);
    expect(mockSessionIndexStore.updateReadState).not.toHaveBeenCalled();
  });

  it.each([
    [
      JSON.stringify({ action: "mark_latest_message_read" }),
      { action: "mark_latest_message_read" },
    ],
    [
      JSON.stringify({
        action: "mark_message_read",
        messageId: "message-1",
      }),
      { action: "mark_message_read", messageId: "message-1" },
    ],
  ])("updates valid read state", async (body, expectedAction) => {
    const response = await patchReadState(body, {
      kind: "user",
      userId: "user-1",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockSessionIndexStore.getVisibleForUser).toHaveBeenCalledWith("session-1", "user-1");
    expect(mockSessionIndexStore.updateReadState).toHaveBeenCalledWith(
      "user-1",
      "session-1",
      expectedAction
    );
  });
});
