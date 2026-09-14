/**
 * Unit tests for the bulk session-trace export route.
 *
 * Tests run in Node (not workerd) with mocked stores and session runtime.
 * Requests dispatch through the production module, so admission (including
 * the sessions.read permission) runs; authentication is mocked to supply the
 * principal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type { Principal } from "../auth/principal";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { Env } from "../types";
import { sessionExportRoutes } from "./session-export";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  list: vi.fn(),
  runtimeFetch: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../db/session-export-store", () => ({
  SessionExportStore: vi.fn().mockImplementation(function () {
    return { list: mocks.list };
  }),
}));

vi.mock("../session/runtime-client", () => ({
  createSessionRuntimeClient: vi.fn(() => ({ fetch: mocks.runtimeFetch })),
}));

vi.mock("../logger", () => ({
  createLogger: vi.fn(() => mocks.logger),
}));

const USER_PRINCIPAL: Principal = { kind: "user", userId: "user-1" };

function createEnv(permissions?: readonly PermissionId[]): Env {
  const db = permissions
    ? authorizationDatabase({ permissions })
    : authorizationDatabase();
  return createTestEnv({
    ...TEST_SERVICE_SECRETS,
    DB: db,
  });
}

function createHandler() {
  return createTestRequestHandler([sessionExportRoutes]);
}

async function callExport(
  query: Record<string, string> = {},
  options?: { permissions?: readonly PermissionId[]; principal?: Principal }
): Promise<Response> {
  const url = new URL("https://test.local/sessions/export");
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  mocks.authenticate.mockImplementation(async (request: Request) => ({
    principal: options?.principal ?? USER_PRINCIPAL,
    request,
  }));
  return createHandler()(
    new Request(url),
    createEnv(options?.permissions),
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

const sampleRow = {
  id: "session-1",
  title: "Fix the login bug",
  status: "completed",
  source: "slack",
  repoOwner: "acme",
  repoName: "web-app",
  model: "claude-sonnet-4-6",
  userId: "user-1",
  automationId: null,
  messageCount: 2,
  totalCost: 0.12,
  activeDurationMs: 45_000,
  createdAt: 1_000,
  updatedAt: 2_000,
};

function messagePage(
  messages: Record<string, unknown>[],
  hasMore: boolean,
  cursor?: string
): Response {
  return Response.json({ messages, hasMore, ...(cursor ? { cursor } : {}) });
}

async function readLines(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("GET /sessions/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a caller without sessions.read before touching the store", async () => {
    const response = await callExport({}, { permissions: [] });

    expect(response.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.runtimeFetch).not.toHaveBeenCalled();
  });

  it("streams one valid NDJSON session line per row with the export content type", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false });

    const response = await callExport();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    const lines = await readLines(response);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      schemaVersion: 1,
      type: "session",
      id: "session-1",
      title: "Fix the login bug",
      status: "completed",
      source: "slack",
      repoOwner: "acme",
      repoName: "web-app",
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    expect(lines[0]).not.toHaveProperty("messages");
    expect(mocks.list).toHaveBeenCalledWith({ cursor: null, limit: 100 });
  });

  it("emits a trailing cursor line when more pages remain, and parses it back", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: true });

    const response = await callExport();
    const lines = await readLines(response);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ schemaVersion: 1, type: "cursor", nextCursor: "1000:session-1" });

    // The emitted cursor round-trips into the next page's keyset filter.
    mocks.list.mockResolvedValue({ sessions: [], hasMore: false });
    await callExport({ cursor: "1000:session-1" });
    expect(mocks.list).toHaveBeenLastCalledWith({
      cursor: { createdAt: 1_000, id: "session-1" },
      limit: 100,
    });
  });

  it("inlines every message page when include=messages", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false });
    mocks.runtimeFetch
      .mockResolvedValueOnce(messagePage([{ id: "msg-1", content: "hello" }], true, "5000"))
      .mockResolvedValueOnce(messagePage([{ id: "msg-2", content: "done" }], false));

    const response = await callExport({ include: "messages" });
    const lines = await readLines(response);

    expect(lines).toHaveLength(1);
    expect(lines[0].messages).toEqual([
      { id: "msg-1", content: "hello" },
      { id: "msg-2", content: "done" },
    ]);
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
    const [sessionId, path, , search] = mocks.runtimeFetch.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(path).toBe("/internal/messages");
    expect(search).toBe("?limit=100");
    expect(mocks.runtimeFetch.mock.calls[1][3]).toBe("?limit=100&cursor=5000");
  });

  it("rejects an invalid cursor without reading the store", async () => {
    const response = await callExport({ cursor: "not-a-cursor" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid cursor" });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range limit without reading the store", async () => {
    const response = await callExport({ limit: "501" });

    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
