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
import { encodeRunsExportCursor } from "../db/session-export-cursor";
import { MAX_INCLUDED_BYTES_PER_SESSION } from "../session/contracts";
import type { Env } from "../types";
import { MAX_INCLUDED_EXPORT_LIMIT, sessionExportRoutes } from "./session-export";

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

/** The session runtime's answer to one trace read. */
function traceResponse(trace: Record<string, unknown>): Response {
  return Response.json({ ok: true, trace });
}

/** A message record passing the runtime trace schema — export fixtures need all fields. */
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

/** A persisted timeline event as the session runtime returns it. */
function sampleEvent(
  id: string,
  createdAt: number,
  timelineSequence: number,
  data: { type: string } & Record<string, unknown>
): Record<string, unknown> {
  return { id, type: data.type, data, messageId: "msg-1", createdAt, timelineSequence };
}

/** A per-step usage row passing the runtime trace schema. */
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
    expect(mocks.list).toHaveBeenCalledWith({ scope: "sessions", cursor: null, limit: 100 });
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
      scope: "sessions",
      cursor: { createdAt: 1_000, id: "session-1", snapshotMaxRowId: 42 },
      limit: 100,
    });
  });

  it("inlines the session's messages from one runtime trace read when include=messages", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    const messages = [sampleMessage("msg-2", "done", 2_000), sampleMessage("msg-1", "hello")];
    mocks.runtimeFetch.mockResolvedValueOnce(traceResponse({ messages }));

    const lines = await readLines(await callExport({ include: "messages" }));

    expect(lines).toHaveLength(1);
    expect(lines[0].messages).toEqual(messages);
    expect(lines[0]).not.toHaveProperty("events");
    expect(lines[0]).not.toHaveProperty("usage");
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(1);
    const [sessionId, path, , search] = mocks.runtimeFetch.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(path).toBe("/internal/trace-export");
    expect(search).toBe("?include=messages");
    expect(mocks.list).toHaveBeenCalledWith({
      scope: "sessions",
      cursor: null,
      limit: MAX_INCLUDED_EXPORT_LIMIT,
    });
  });

  it("inlines the prompt, tool activity, step tokens and outcome on one session line", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    const trace = {
      messages: [sampleMessage("msg-1", "Run the tests")],
      events: [
        sampleEvent("tool_call:call-1", 1_150, 1, {
          type: "tool_call",
          tool: "bash",
          args: { command: "npm test" },
          callId: "call-1",
          status: "completed",
          output: "1 passed",
        }),
        sampleEvent("execution_complete:msg-1", 1_300, 2, {
          type: "execution_complete",
          success: true,
        }),
      ],
      usage: [sampleUsage("step-1", 1_250, 2_300)],
    };
    mocks.runtimeFetch.mockResolvedValueOnce(traceResponse(trace));

    const lines = await readLines(await callExport({ include: "usage,events,messages" }));

    expect(lines).toEqual([{ schemaVersion: 1, type: "session", ...sampleRow, ...trace }]);
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeFetch.mock.calls[0][3]).toBe("?include=messages%2Cevents%2Cusage");
  });

  it("forwards compact format to the session runtime", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch.mockResolvedValueOnce(traceResponse({ events: [] }));
    await readLines(await callExport({ include: "events", format: "compact" }));
    expect(mocks.runtimeFetch.mock.calls[0][3]).toBe("?include=events&format=compact");
  });

  it("forwards runs scope, its cursor and root window while retaining include and compact format", async () => {
    const cursor = {
      rootCreatedAt: 900,
      rootSessionId: "root-1",
      spawnDepth: 1,
      createdAt: 1_000,
      id: "session-1",
      snapshotMaxRowId: 42,
    };
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: true, nextCursor: cursor });
    mocks.runtimeFetch.mockResolvedValueOnce(traceResponse({ events: [] }));

    const response = await callExport({
      scope: "runs",
      cursor: encodeRunsExportCursor(cursor),
      createdAfter: "800",
      createdBefore: "950",
      include: "events",
      format: "compact",
    });

    expect(await readLines(response)).toMatchObject([
      { type: "session", id: "session-1", events: [] },
      { type: "cursor", nextCursor: encodeRunsExportCursor(cursor) },
    ]);
    expect(mocks.list).toHaveBeenCalledWith({
      scope: "runs",
      cursor,
      createdAfter: 800,
      createdBefore: 950,
      limit: MAX_INCLUDED_EXPORT_LIMIT,
    });
    expect(mocks.runtimeFetch.mock.calls[0][3]).toBe("?include=events&format=compact");
  });

  it("keeps default sessions output byte-identical to explicit scope=sessions", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    const original = await (await callExport()).text();
    const explicit = await (await callExport({ scope: "sessions" })).text();
    expect(original).toBe(
      `${JSON.stringify({ schemaVersion: 1, type: "session", ...sampleRow })}\n`
    );
    expect(explicit).toBe(original);
  });

  it("rejects invalid format before reading sessions", async () => {
    const response = await callExport({ include: "events", format: "unknown" });
    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
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
      traceResponse({
        messages: [
          {
            ...sampleMessage("msg-1", "inspect this"),
            attachments: [
              { attachmentId: "attachment-1", name: "trace.png", mimeType: "image/png" },
            ],
          },
        ],
      })
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

  it.each([
    { scope: "runs", cursor: "1000:session-1:42" },
    {
      scope: "sessions",
      cursor: encodeRunsExportCursor({
        rootCreatedAt: 900,
        rootSessionId: "root-1",
        spawnDepth: 1,
        createdAt: 1_000,
        id: "session-1",
        snapshotMaxRowId: 42,
      }),
    },
  ])("rejects a $scope request with the other scope's cursor", async (query) => {
    const response = await callExport(query);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid cursor" });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("rejects an unknown scope", async () => {
    const response = await callExport({ scope: "other" });
    expect(response.status).toBe(400);
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

  it("emits a session_error line and continues when a session's trace read 500s", async () => {
    const secondRow = { ...sampleRow, id: "session-2", createdAt: 3_000 };
    mocks.list.mockResolvedValue({
      sessions: [sampleRow, secondRow],
      hasMore: false,
      nextCursor: null,
    });
    mocks.runtimeFetch
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(traceResponse({ messages: [sampleMessage("msg-ok", "fine")] }));

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
      .mockResolvedValueOnce(traceResponse({ messages: [sampleMessage("msg-ok", "fine")] }));

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
      "omits the outcome",
      () => Response.json({ trace: { messages: [sampleMessage("msg-1", "hello")] } }),
    ],
    [
      "drops a required message field",
      () => {
        const malformed = sampleMessage("msg-1", "hello");
        delete malformed.createdAt;
        return traceResponse({ messages: [malformed] });
      },
    ],
    [
      "drops an event's timeline sequence",
      () => {
        const { timelineSequence: _timelineSequence, ...event } = sampleEvent(
          "token:msg-1",
          1_100,
          1,
          { type: "token", content: "hi" }
        );
        return traceResponse({ events: [event] });
      },
    ],
    [
      "types ok as a string",
      () => Response.json({ ok: "true", trace: { messages: [sampleMessage("msg-1", "hello")] } }),
    ],
  ])("emits only a session_error line when a trace response %s", async (_name, makeResponse) => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch.mockResolvedValueOnce(makeResponse());

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

  it.each([["page_cap_reached"], ["message_budget_exceeded"]])(
    "emits only a session_error line when the runtime reports %s",
    async (reason) => {
      mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
      mocks.runtimeFetch.mockResolvedValueOnce(Response.json({ ok: false, reason }));

      const lines = await readLines(await callExport({ include: "messages,events" }));

      expect(lines).toEqual([
        { schemaVersion: 1, type: "session_error", sessionId: "session-1", reason },
      ]);
    }
  );

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

  it("does not retain a session whose trace response exceeds the byte budget", async () => {
    mocks.list.mockResolvedValue({ sessions: [sampleRow], hasMore: false, nextCursor: null });
    mocks.runtimeFetch.mockResolvedValueOnce(
      traceResponse({
        messages: [sampleMessage("msg-large", "x".repeat(MAX_INCLUDED_BYTES_PER_SESSION))],
      })
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
});
