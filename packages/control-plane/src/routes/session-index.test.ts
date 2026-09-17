import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleListSessionInbox, handleListSessions, handlePatchReadState } from "./session-index";
import type { RequestContext, UserRouteContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import type { Principal } from "../auth/principal";
import { createTestEnv, TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

const mockSessionIndexStore = {
  list: vi.fn(),
  listInbox: vi.fn(),
  listInboxSnapshot: vi.fn(),
  delete: vi.fn(),
  updateReadState: vi.fn(),
};

vi.mock("../db/session-index", () => ({
  SessionIndexStore: vi.fn().mockImplementation(function () {
    return mockSessionIndexStore;
  }),
}));

function createCtx(principal?: Principal): RequestContext {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => ({
      user_id: "user-1",
      suspended_at: null,
      role_id: "role_builtin_owner",
      role_key: "owner",
      role_name: "Owner",
    })),
    all: vi.fn(async () => ({ results: [] })),
  };
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db: { prepare: vi.fn(() => statement) } as unknown as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    metrics: {
      sqlQueries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
    principal,
    ...(principal?.kind === "user"
      ? {
          authorization: {
            userId: principal.userId,
            suspendedAt: null,
            role: { id: "role_builtin_owner", key: "owner" as const, name: "Owner" },
            permissions: ["sessions.read", "sessions.delete", "sessions.lifecycle"] as const,
          },
        }
      : {}),
  };
}

function createEnv(): Env {
  return createTestEnv();
}

async function listSessions(query = "", principal?: Principal): Promise<Response> {
  return handleListSessions(
    new Request(`https://test.local/sessions${query}`),
    createEnv(),
    {},
    createCtx(principal)
  );
}

const USER_PRINCIPAL: Principal = { kind: "user", userId: "user-1" };

const listSession = {
  id: "session-1",
  title: "Session 1",
  repoOwner: "open-inspect",
  repoName: "background-agents",
  harness: "opencode" as const,
  model: "anthropic/claude-sonnet-4-6",
  reasoningEffort: null,
  baseBranch: "main",
  status: "active" as const,
  parentSessionId: null,
  spawnSource: "user" as const,
  spawnDepth: 0,
  automationId: null,
  automationRunId: null,
  scmLogin: "octocat",
  userId: "user-1",
  totalCost: 0,
  activeDurationMs: 0,
  messageCount: 1,
  prCount: 0,
  environmentId: null,
  createdAt: 100,
  updatedAt: 200,
};

const inboxSession = {
  id: listSession.id,
  title: listSession.title,
  repoOwner: listSession.repoOwner,
  repoName: listSession.repoName,
  baseBranch: listSession.baseBranch,
  status: listSession.status,
  parentSessionId: listSession.parentSessionId,
  spawnSource: listSession.spawnSource,
  environmentId: listSession.environmentId,
  createdAt: listSession.createdAt,
  updatedAt: listSession.updatedAt,
  readState: { latestMessageId: "message-1", unread: true, version: 200 },
};

const emptyInboxResult = { items: [], hasMore: false, nextCursor: null };

async function listInbox(query = ""): Promise<Response> {
  return handleListSessionInbox(
    new Request(`https://test.local/sessions/inbox${query}`),
    createEnv(),
    {},
    createCtx(USER_PRINCIPAL) as UserRouteContext
  );
}

async function patchReadState(body: string, principal?: Principal): Promise<Response> {
  return handlePatchReadState(
    new Request("https://test.local/sessions/session-1/read-state", {
      method: "PATCH",
      body,
    }),
    createEnv(),
    { id: "session-1" },
    createCtx(principal) as UserRouteContext
  );
}

describe("session index routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionIndexStore.list.mockResolvedValue({
      sessions: [],
      hasMore: false,
    });
    mockSessionIndexStore.listInbox.mockResolvedValue(emptyInboxResult);
    mockSessionIndexStore.listInboxSnapshot.mockResolvedValue({
      needs_attention: emptyInboxResult,
      in_progress: emptyInboxResult,
      finished: emptyInboxResult,
    });
    mockSessionIndexStore.updateReadState.mockResolvedValue({
      sessionId: "session-1",
      outcome: "marked_read",
      unread: false,
      latestMessageId: "message-1",
      version: 1_000,
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

  it("preserves viewer read state on authenticated session lists", async () => {
    const readState = { latestMessageId: "message-1", unread: true, version: 200 };
    mockSessionIndexStore.list.mockResolvedValue({
      sessions: [{ ...listSession, readState }],
      hasMore: false,
    });

    const response = await listSessions("", USER_PRINCIPAL);

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      sessions: [{ ...listSession, readState }],
      hasMore: false,
    });
  });

  it("projects flat session list responses through the shared schema", async () => {
    mockSessionIndexStore.list.mockResolvedValue({
      sessions: [{ ...listSession, providerAuth: [{ secret: "internal" }] }],
      hasMore: true,
    });

    const response = await listSessions();
    await expect(response.json()).resolves.toEqual({
      sessions: [listSession],
      hasMore: true,
    });
  });

  it("projects inbox page and snapshot responses through their shared schemas", async () => {
    const item = { rootSession: inboxSession, descendantSessions: [] };
    const storedItem = {
      rootSession: { ...inboxSession, providerAuth: [{ secret: "internal" }] },
      descendantSessions: [],
    };
    mockSessionIndexStore.listInbox.mockResolvedValue({
      items: [storedItem],
      hasMore: true,
      nextCursor: { latestUpdatedAt: 200, rootSessionId: "session-1" },
    });
    mockSessionIndexStore.listInboxSnapshot.mockResolvedValue({
      needs_attention: { items: [storedItem], hasMore: false, nextCursor: null },
      in_progress: emptyInboxResult,
      finished: emptyInboxResult,
    });

    const pageResponse = await listInbox("?category=needs_attention");
    const snapshotResponse = await listInbox();
    await expect(pageResponse.json()).resolves.toEqual({
      items: [item],
      hasMore: true,
      nextCursor: "200:session-1",
    });
    await expect(snapshotResponse.json()).resolves.toEqual({
      categories: {
        needs_attention: { items: [item], hasMore: false, nextCursor: null },
        in_progress: emptyInboxResult,
        finished: emptyInboxResult,
      },
    });
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

  it.each([
    ["?category=bogus", "Invalid category"],
    ["?category=finished&category=in_progress", "Invalid category"],
    ["?category=finished&cursor=", "Invalid cursor"],
    ["?cursor=1:abc", "Category required for pagination"],
    ["?category=finished&cursor=not-a-cursor", "Invalid cursor"],
    ["?category=finished&mine=false", "Invalid mine"],
    ["?category=finished&mine=true&mine=true", "Invalid mine"],
  ])("rejects the inbox query %s before reading the store", async (query, error) => {
    const response = await listInbox(query);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mockSessionIndexStore.listInbox).not.toHaveBeenCalled();
    expect(mockSessionIndexStore.listInboxSnapshot).not.toHaveBeenCalled();
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
    expect(mockSessionIndexStore.updateReadState).toHaveBeenCalledWith(
      "user-1",
      "session-1",
      expectedAction
    );
  });
});
