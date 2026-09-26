/**
 * Unit tests for the bulk session-trace export route.
 *
 * Tests run in Node (not workerd) with mocked stores and session runtime.
 * Requests dispatch through the production module, so admission (including
 * the sessions.export permission) runs; authentication is mocked to supply the
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
import type { SessionExportRow } from "../db/session-export-store";
import { SessionInternalPaths, type SessionInternalPath } from "../session/contracts";
import type { Env } from "../types";
import {
  MAX_INCLUDED_BYTES_PER_SESSION,
  MAX_INCLUDED_EXPORT_LIMIT,
  MAX_INCLUDED_PAGES_PER_SESSION,
  sessionExportRoutes,
} from "./session-export";

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
  const db = permissions ? authorizationDatabase({ permissions }) : authorizationDatabase();
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
  source: "slack-bot",
  spawnSource: "slack-bot",
  parentSessionId: "root-1",
  rootSessionId: "root-1",
  spawnDepth: 1,
  harness: "opencode",
  repoOwner: "acme",
  repoName: "web-app",
  baseBranch: "main",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  reasoningEffort: "high",
  userId: "user-1",
  scmLogin: "alice",
  automationId: null,
  automationRunId: null,
  environmentId: "env-1",
  messageCount: 2,
  prCount: 1,
  totalCost: 0.12,
  activeDurationMs: 45_000,
  inputTokens: 100,
  outputTokens: 30,
  reasoningTokens: 5,
  cacheReadTokens: 40,
  cacheWriteTokens: 2,
  repositories: [
    { repoOwner: "acme", repoName: "web-app", repoId: 12, baseBranch: "main" },
    { repoOwner: "acme", repoName: "api", repoId: 13, baseBranch: "develop" },
  ],
  pullRequests: [
    {
      repoOwner: "acme",
      repoName: "api",
      prNumber: 42,
      url: "https://example.com/acme/api/pull/42",
      lifecycleState: "merged",
      isDraft: false,
      headBranch: "feature/login",
      baseBranch: "develop",
      headSha: "abc123",
      providerCreatedAt: 900,
      mergedAt: 1_500,
      closedAt: 1_500,
    },
  ],
  createdAt: 1_000,
  updatedAt: 2_000,
} satisfies SessionExportRow;

/** One runtime page, newest first, keyed by the collection it carries. */
function runtimePage(
  collection: "messages" | "events" | "usage",
  items: Record<string, unknown>[],
  hasMore: boolean,
  cursor?: string
): Response {
  return Response.json({ [collection]: items, hasMore, ...(cursor ? { cursor } : {}) });
}

/** Answers each runtime path with its queued pages in order; an unqueued fetch fails. */
function serveRuntimePages(pages: Partial<Record<SessionInternalPath, Response[]>>): void {
  mocks.runtimeFetch.mockImplementation((_sessionId: string, path: SessionInternalPath) => {
    const page = pages[path]?.shift();
    return page ? Promise.resolve(page) : Promise.reject(new Error(`unexpected ${path} fetch`));
  });
}

/** A message record passing the runtime page schema — export fixtures need all fields. */
function sampleMessage(id: string, content: string, createdAt = 1_000): Record<string, unknown> {
  return {
    id,
    authorId: "user-1",
    content,
    source: "slack",
    attachments: null,
    status: "completed",
    createdAt,
    startedAt: createdAt + 100,
    completedAt: createdAt + 200,
  };
}

/** A persisted timeline event as `/internal/events` returns it. */
function sampleEvent(
  id: string,
  createdAt: number,
  data: { type: string } & Record<string, unknown>
): Record<string, unknown> {
  return { id, type: data.type, data, messageId: "msg-1", createdAt };
}

/** A per-step usage row passing the runtime page schema. */
function sampleUsage(id: string, createdAt: number, totalTokens: number): Record<string, unknown> {
  return {
    id,
    messageId: "msg-1",
    model: "anthropic/claude-sonnet-4-6",
    harness: "opencode",
    inputTokens: totalTokens - 100,
    outputTokens: 100,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens,
    stepCostUsd: 0.01,
    messageCostUsd: 0.02,
    isSubtask: false,
    childSessionId: null,
    taskCallId: null,
    reason: "tool-calls",
    createdAt,
  };
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
    mocks.runtimeFetch.mockReset();
  });

  it("rejects a caller without sessions.export before touching the store", async () => {
    const response = await callExport({}, { permissions: [] });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ permission: "sessions.export" });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.runtimeFetch).not.toHaveBeenCalled();
  });

  it("rejects a Viewer with sessions.read", async () => {
    const response = await callExport({}, { permissions: ["sessions.read"] });

    expect(response.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("works on a GitLab deployment", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: USER_PRINCIPAL,
      request,
    }));

    const response = await createHandler()(
      new Request("https://test.local/sessions/export"),
      { ...createEnv(), SCM_PROVIDER: "gitlab" },
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(await readLines(response)).toMatchObject([{ type: "session", id: "session-1" }]);
  });

  it("streams one valid NDJSON session line per row with the export content type", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });

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
      source: "slack-bot",
      spawnSource: "slack-bot",
      parentSessionId: "root-1",
      rootSessionId: "root-1",
      spawnDepth: 1,
      harness: "opencode",
      repoOwner: "acme",
      repoName: "web-app",
      baseBranch: "main",
      provider: "anthropic",
      reasoningEffort: "high",
      scmLogin: "alice",
      automationRunId: null,
      environmentId: "env-1",
      prCount: 1,
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheReadTokens: 40,
      cacheWriteTokens: 2,
      repositories: sampleRow.repositories,
      pullRequests: sampleRow.pullRequests,
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    expect(lines[0]).not.toHaveProperty("messages");
    expect(mocks.list).toHaveBeenCalledWith({ cursor: null, limit: 100 });
  });

  it("emits a trailing cursor line when more pages remain, and parses it back", async () => {
    mocks.list.mockResolvedValue({
      sessions: [sampleRow],
      hasMore: true,
      nextCursor: { createdAt: 1_000, id: "session-1", snapshotMaxRowId: 42 },
    });

    const response = await callExport();
    const lines = await readLines(response);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      schemaVersion: 1,
      type: "cursor",
      nextCursor: "1000:session-1:42",
    });

    // The emitted cursor round-trips into the next page's keyset filter.
    mocks.list.mockResolvedValue({ sessions: [], hasMore: false, nextCursor: null });
    await callExport({ cursor: "1000:session-1:42" });
    expect(mocks.list).toHaveBeenLastCalledWith({
      cursor: { createdAt: 1_000, id: "session-1", snapshotMaxRowId: 42 },
      limit: 100,
    });
  });

  it("inlines every message page oldest first when include=messages", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch
      .mockResolvedValueOnce(
        runtimePage("messages", [sampleMessage("msg-2", "done", 2_000)], true, "5000")
      )
      .mockResolvedValueOnce(runtimePage("messages", [sampleMessage("msg-1", "hello")], false));

    const response = await callExport({ include: "messages" });
    const lines = await readLines(response);

    expect(lines).toHaveLength(1);
    expect(lines[0].messages).toEqual([
      sampleMessage("msg-1", "hello"),
      sampleMessage("msg-2", "done", 2_000),
    ]);
    expect(lines[0]).not.toHaveProperty("events");
    expect(lines[0]).not.toHaveProperty("usage");
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
    const [sessionId, path, , search] = mocks.runtimeFetch.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(path).toBe("/internal/messages");
    expect(search).toBe("?limit=100");
    expect(mocks.runtimeFetch.mock.calls[1][3]).toBe("?limit=100&cursor=5000");
    expect(mocks.list).toHaveBeenCalledWith({ cursor: null, limit: MAX_INCLUDED_EXPORT_LIMIT });
  });

  it("inlines every event page in timeline order when include=events", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    const toolCall = sampleEvent("tool_call:call-1", 1_100, {
      type: "tool_call",
      tool: "bash",
      args: { command: "npm test" },
      callId: "call-1",
      status: "completed",
      output: "1 passed",
    });
    const token = sampleEvent("token:msg-1", 1_200, { type: "token", content: "Tests pass." });
    const complete = sampleEvent("execution_complete:msg-1", 1_300, {
      type: "execution_complete",
      success: true,
    });
    mocks.runtimeFetch
      .mockResolvedValueOnce(runtimePage("events", [complete, token], true, "1200:token:msg-1"))
      .mockResolvedValueOnce(runtimePage("events", [toolCall], false, "1100:tool_call:call-1"));

    const lines = await readLines(await callExport({ include: "events" }));

    expect(lines).toHaveLength(1);
    expect(lines[0].events).toEqual([toolCall, token, complete]);
    expect(lines[0]).not.toHaveProperty("messages");
    expect(mocks.runtimeFetch.mock.calls.map(([, path, , search]) => [path, search])).toEqual([
      ["/internal/events", "?limit=100"],
      ["/internal/events", "?limit=100&cursor=1200%3Atoken%3Amsg-1"],
    ]);
    expect(mocks.list).toHaveBeenCalledWith({ cursor: null, limit: MAX_INCLUDED_EXPORT_LIMIT });
  });

  it("inlines every per-step usage row oldest first when include=usage", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch
      .mockResolvedValueOnce(
        runtimePage("usage", [sampleUsage("step-2", 1_250, 2_000)], true, "1250:step-2")
      )
      .mockResolvedValueOnce(runtimePage("usage", [sampleUsage("step-1", 1_150, 1_000)], false));

    const lines = await readLines(await callExport({ include: "usage" }));

    expect(lines).toHaveLength(1);
    expect(lines[0].usage).toEqual([
      sampleUsage("step-1", 1_150, 1_000),
      sampleUsage("step-2", 1_250, 2_000),
    ]);
    expect(mocks.runtimeFetch.mock.calls.map(([, path, , search]) => [path, search])).toEqual([
      ["/internal/usage", "?limit=100"],
      ["/internal/usage", "?limit=100&cursor=1250%3Astep-2"],
    ]);
  });

  it("inlines the prompt, tool activity, step tokens and outcome on one session line", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    const prompt = sampleMessage("msg-1", "Run the tests");
    const toolCall = sampleEvent("tool_call:call-1", 1_150, {
      type: "tool_call",
      tool: "bash",
      args: { command: "npm test" },
      callId: "call-1",
      status: "completed",
      output: "1 passed",
    });
    const complete = sampleEvent("execution_complete:msg-1", 1_300, {
      type: "execution_complete",
      success: true,
    });
    const step = sampleUsage("step-1", 1_250, 2_300);
    serveRuntimePages({
      [SessionInternalPaths.messages]: [runtimePage("messages", [prompt], false)],
      [SessionInternalPaths.events]: [runtimePage("events", [complete, toolCall], false)],
      [SessionInternalPaths.usage]: [runtimePage("usage", [step], false)],
    });

    const lines = await readLines(await callExport({ include: "usage,events,messages" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session",
        ...sampleRow,
        messages: [prompt],
        events: [toolCall, complete],
        usage: [step],
      },
    ]);
    expect(mocks.runtimeFetch.mock.calls.map(([, path]) => path)).toEqual([
      "/internal/messages",
      "/internal/events",
      "/internal/usage",
    ]);
  });

  it.each([["prompts"], ["messages,prompts"], ["messages,"], [""]])(
    "rejects include=%s without reading the store",
    async (include) => {
      const response = await callExport({ include });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "include must be a comma-separated list of messages, events, usage",
      });
      expect(mocks.list).not.toHaveBeenCalled();
    }
  );

  it("preserves validated message attachment metadata", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch.mockResolvedValueOnce(
      runtimePage(
        "messages",
        [
          {
            ...sampleMessage("msg-1", "inspect this"),
            attachments: [
              { attachmentId: "attachment-1", name: "trace.png", mimeType: "image/png" },
            ],
          },
        ],
        false
      )
    );

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines[0].messages).toEqual([
      expect.objectContaining({
        attachments: [{ attachmentId: "attachment-1", name: "trace.png", mimeType: "image/png" }],
      }),
    ]);
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

  it.each([["messages"], ["events"], ["usage"], ["messages,events,usage"]])(
    "applies the smaller request budget when include=%s",
    async (include) => {
      const response = await callExport({
        include,
        limit: String(MAX_INCLUDED_EXPORT_LIMIT + 1),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: `limit must be at most ${MAX_INCLUDED_EXPORT_LIMIT} when include is set`,
      });
      expect(mocks.list).not.toHaveBeenCalled();
    }
  );

  it.each([["createdAfter"], ["createdBefore"]])(
    "rejects an empty %s instead of coercing it to epoch zero",
    async (param) => {
      const response = await callExport({ [param]: "" });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(`${param} must be a non-negative integer`);
      expect(mocks.list).not.toHaveBeenCalled();
    }
  );

  it("emits a session_error line and continues when a session's messages 500", async () => {
    const secondRow = { ...sampleRow, id: "session-2", createdAt: 3_000 };
    mocks.list.mockResolvedValue({
      sessions: [sampleRow, secondRow],
      hasMore: false,
      nextCursor: null,
    });
    mocks.runtimeFetch
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(runtimePage("messages", [sampleMessage("msg-ok", "fine")], false));

    const response = await callExport({ include: "messages" });
    const lines = await readLines(response);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      schemaVersion: 1,
      type: "session_error",
      sessionId: "session-1",
      reason: "http_error",
      status: 503,
    });
    expect(lines[0]).not.toHaveProperty("messages");
    expect(lines[1]).toMatchObject({ type: "session", id: "session-2" });
    expect(lines[1].messages).toEqual([sampleMessage("msg-ok", "fine")]);
  });

  it("emits a session_error line and continues when the runtime rejects a fetch", async () => {
    const secondRow = { ...sampleRow, id: "session-2", createdAt: 3_000 };
    mocks.list.mockResolvedValue({
      sessions: [sampleRow, secondRow],
      hasMore: false,
      nextCursor: null,
    });
    mocks.runtimeFetch
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(runtimePage("messages", [sampleMessage("msg-ok", "fine")], false));

    const response = await callExport({ include: "messages" });
    expect(response.status).toBe(200);

    const lines = await readLines(response);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      schemaVersion: 1,
      type: "session_error",
      sessionId: "session-1",
      reason: "runtime_failure",
    });
    expect(lines[1]).toMatchObject({ type: "session", id: "session-2" });
  });

  it.each([
    [
      "claims hasMore without a cursor",
      () => Response.json({ messages: [sampleMessage("msg-1", "hello")], hasMore: true }),
    ],
    [
      "drops a required message field",
      () => {
        const malformed = sampleMessage("msg-1", "hello");
        delete malformed.createdAt;
        return runtimePage("messages", [malformed], false);
      },
    ],
    [
      "types hasMore as a string",
      () => Response.json({ messages: [sampleMessage("msg-1", "hello")], hasMore: "false" }),
    ],
  ])("emits only a session_error line when a page %s", async (_name, makePage) => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch.mockResolvedValueOnce(makePage());

    const response = await callExport({ include: "messages" });
    const lines = await readLines(response);

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "runtime_failure",
      },
    ]);
  });

  it("rejects a repeated runtime cursor instead of burning through the page cap", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch
      .mockResolvedValueOnce(runtimePage("messages", [sampleMessage("msg-1", "one")], true, "same"))
      .mockResolvedValueOnce(
        runtimePage("messages", [sampleMessage("msg-2", "two")], true, "same")
      );

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "runtime_failure",
      },
    ]);
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight runtime request when the reader cancels", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    let fetchSignal: AbortSignal | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    mocks.runtimeFetch.mockImplementation((_sessionId, _path, init: RequestInit) => {
      fetchSignal = init.signal as AbortSignal;
      markFetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
      });
    });

    const response = await callExport({ include: "messages" });
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await fetchStarted;
    await reader.cancel();

    expect(fetchSignal?.aborted).toBe(true);
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not retain a session whose messages exceed the byte budget", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch.mockResolvedValueOnce(
      runtimePage(
        "messages",
        [sampleMessage("msg-large", "x".repeat(MAX_INCLUDED_BYTES_PER_SESSION))],
        false
      )
    );

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "message_budget_exceeded",
      },
    ]);
  });

  it("cancels a runtime response before parsing when it exceeds the byte budget", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_INCLUDED_BYTES_PER_SESSION + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    mocks.runtimeFetch.mockResolvedValueOnce(new Response(body));

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "message_budget_exceeded",
      },
    ]);
    expect(cancelled).toBe(true);
  });

  it("applies the response byte budget across all message pages", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    const padding = "x".repeat(MAX_INCLUDED_BYTES_PER_SESSION / 2);
    mocks.runtimeFetch
      .mockResolvedValueOnce(
        Response.json({ messages: [], hasMore: true, cursor: "next", padding })
      )
      .mockResolvedValueOnce(Response.json({ messages: [], hasMore: false, padding }));

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "message_budget_exceeded",
      },
    ]);
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
  });

  it("does not serialize truncated messages when the page cap is reached", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    let page = 0;
    mocks.runtimeFetch.mockImplementation(() =>
      Promise.resolve(
        runtimePage("messages", [sampleMessage(`msg-${page++}`, "part")], true, String(page))
      )
    );

    const response = await callExport({ include: "messages" });
    const lines = await readLines(response);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: "session_error",
      sessionId: "session-1",
      reason: "page_cap_reached",
    });
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(MAX_INCLUDED_PAGES_PER_SESSION);
  });

  it("shares one byte budget across messages and events", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    const overHalfBudget = "x".repeat(MAX_INCLUDED_BYTES_PER_SESSION / 2 + 1);
    serveRuntimePages({
      [SessionInternalPaths.messages]: [
        runtimePage("messages", [sampleMessage("msg-1", overHalfBudget)], false),
      ],
      [SessionInternalPaths.events]: [
        runtimePage(
          "events",
          [sampleEvent("token:msg-1", 1_100, { type: "token", content: overHalfBudget })],
          false
        ),
      ],
    });

    const lines = await readLines(await callExport({ include: "messages,events" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "message_budget_exceeded",
      },
    ]);
    expect(mocks.runtimeFetch.mock.calls.map(([, path]) => path)).toEqual([
      "/internal/messages",
      "/internal/events",
    ]);
  });

  it("starts each session with a fresh byte budget", async () => {
    const secondRow = { ...sampleRow, id: "session-2", createdAt: 3_000 };
    mocks.list.mockResolvedValue({
      sessions: [sampleRow, secondRow],
      hasMore: false,
      nextCursor: null,
    });
    const overHalfBudget = "x".repeat(MAX_INCLUDED_BYTES_PER_SESSION / 2 + 1);
    serveRuntimePages({
      [SessionInternalPaths.messages]: [
        runtimePage("messages", [sampleMessage("msg-1", overHalfBudget)], false),
        runtimePage("messages", [sampleMessage("msg-2", overHalfBudget)], false),
      ],
    });

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toMatchObject([
      { type: "session", id: "session-1", messages: [{ id: "msg-1" }] },
      { type: "session", id: "session-2", messages: [{ id: "msg-2" }] },
    ]);
  });

  it("shares one page cap across included collections", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    let messagePages = 0;
    let eventPages = 0;
    mocks.runtimeFetch.mockImplementation((_sessionId: string, path: SessionInternalPath) => {
      if (path === SessionInternalPaths.messages) {
        messagePages++;
        const last = messagePages === MAX_INCLUDED_PAGES_PER_SESSION - 1;
        const message = sampleMessage(`msg-${messagePages}`, "part");
        return Promise.resolve(
          runtimePage("messages", [message], !last, last ? undefined : `m${messagePages}`)
        );
      }
      eventPages++;
      const event = sampleEvent(`event-${eventPages}`, 1_100, { type: "token", content: "part" });
      return Promise.resolve(runtimePage("events", [event], true, `e${eventPages}`));
    });

    const lines = await readLines(await callExport({ include: "messages,events" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "page_cap_reached",
      },
    ]);
    expect(messagePages).toBe(MAX_INCLUDED_PAGES_PER_SESSION - 1);
    expect(eventPages).toBe(1);
  });

  it("emits only a session_error line when a later collection fails", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    serveRuntimePages({
      [SessionInternalPaths.messages]: [
        runtimePage("messages", [sampleMessage("msg-1", "hello")], false),
      ],
      [SessionInternalPaths.events]: [new Response("boom", { status: 503 })],
    });

    const lines = await readLines(await callExport({ include: "messages,events,usage" }));

    expect(lines).toEqual([
      {
        schemaVersion: 1,
        type: "session_error",
        sessionId: "session-1",
        reason: "http_error",
        status: 503,
      },
    ]);
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
  });
});
