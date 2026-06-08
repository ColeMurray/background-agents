import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@open-inspect/shared";
import { handleSlackNotify } from "./slack-notify";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const sessionStoreMock = {
  get: vi.fn(),
};

const integrationStoreMock = {
  getResolvedConfig: vi.fn(),
};

vi.mock("../db/session-index", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SessionIndexStore: vi.fn().mockImplementation(function () {
      return sessionStoreMock;
    }),
  };
});

vi.mock("../db/integration-settings", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    IntegrationSettingsStore: vi.fn().mockImplementation(function () {
      return integrationStoreMock;
    }),
  };
});

const fetchMock = vi.fn();

const sessionFetchMock = vi.fn();

const PATH = "/sessions/sess-1/slack-notify";
const PATTERN = /^\/sessions\/(?<id>[^/]+)\/slack-notify$/;

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(overrides?: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    SESSION: {
      idFromName: vi.fn().mockReturnValue("fake-do-id"),
      get: vi.fn().mockReturnValue({ fetch: sessionFetchMock }),
    } as unknown as DurableObjectNamespace,
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "test-key",
    SLACK_BOT_TOKEN: "xoxb-test",
    APP_NAME: "Open-Inspect",
    WEB_APP_URL: "https://app.example.com",
    ...overrides,
  } as Env;
}

async function callHandler(body: unknown, envOverrides?: Partial<Env>): Promise<Response> {
  const match = PATH.match(PATTERN)!;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handleSlackNotify(
    new Request(`https://test.local${PATH}`, init),
    createEnv(envOverrides),
    match,
    createCtx()
  );
}

function seedActiveSession(opts?: {
  parentSessionId?: string | null;
  spawnSource?: string;
  userId?: string | null;
  status?: SessionStatus;
  repoOwner?: string;
  repoName?: string;
}) {
  sessionStoreMock.get.mockResolvedValue({
    id: "sess-1",
    title: "Test session",
    repoOwner: opts?.repoOwner ?? "acme",
    repoName: opts?.repoName ?? "web-app",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: null,
    status: opts?.status ?? "active",
    parentSessionId: opts?.parentSessionId ?? null,
    spawnSource: opts?.spawnSource ?? "user",
    spawnDepth: 0,
    userId: opts?.userId ?? "user-1",
    createdAt: 1,
    updatedAt: 1,
  });
}

function mockSlackResponse(opts: { status?: number; body?: unknown; retryAfter?: string }) {
  fetchMock.mockResolvedValueOnce(
    new Response(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? {}), {
      status: opts.status ?? 200,
      headers: opts.retryAfter ? { "retry-after": opts.retryAfter } : undefined,
    })
  );
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  sessionFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

function lastLogPayload(
  spy: ReturnType<typeof vi.spyOn>,
  msg: string
): Record<string, unknown> | undefined {
  for (let i = spy.mock.calls.length - 1; i >= 0; i--) {
    const call = spy.mock.calls[i];
    for (const arg of call) {
      if (typeof arg !== "string") continue;
      try {
        const parsed = JSON.parse(arg) as Record<string, unknown>;
        if (parsed.msg === msg) return parsed;
      } catch {
        /* skip */
      }
    }
  }
  return undefined;
}

describe("handleSlackNotify", () => {
  it("happy path posts no events to the DO — the agent's tool_call is the source of truth", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C1", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    await callHandler({ channel: "#ops", text: "hello" });

    expect(sessionFetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 feature_unavailable and logs at error level when SLACK_BOT_TOKEN is missing", async () => {
    seedActiveSession();
    const res = await callHandler(
      { channel: "#ops", text: "hello" },
      { SLACK_BOT_TOKEN: undefined }
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("feature_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionFetchMock).not.toHaveBeenCalled();
    // Misconfig must log at error (not warn) so it reaches alerting.
    const errorEntry = lastLogPayload(
      consoleErrorSpy,
      "Slack notification denied: SLACK_BOT_TOKEN is not configured"
    );
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.reason).toBe("feature_unavailable");
  });

  it("returns feature_disabled when global master switch is off", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: false, mentionsPolicy: "allow" },
    });

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("feature_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionFetchMock).not.toHaveBeenCalled();
  });

  // The handler reads only the resolved master switch (returned by
  // getResolvedConfig, which already merges global + repo). Whether the
  // resolved `false` came from a global default or a repo override is not
  // the handler's concern — that resolution is covered by
  // IntegrationSettingsStore tests in db/integration-settings.test.ts.
  it("does not call Slack when feature_disabled regardless of resolution source", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: false, mentionsPolicy: "allow" },
    });

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Slack channel_not_found to channel_not_found_or_forbidden", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: false, error: "channel_not_found" } });

    const res = await callHandler({ channel: "#nope", text: "hello" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("channel_not_found_or_forbidden");
  });

  it("maps Slack not_in_channel to channel_not_found_or_forbidden", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: false, error: "not_in_channel" } });

    const res = await callHandler({ channel: "#nope", text: "hello" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("channel_not_found_or_forbidden");
  });

  it("maps Slack is_archived to channel_not_found_or_forbidden", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: false, error: "is_archived" } });

    const res = await callHandler({ channel: "#archive", text: "hello" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("channel_not_found_or_forbidden");
  });

  it("maps Slack 429 to rate_limited and surfaces Retry-After", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ status: 429, body: "", retryAfter: "30" });

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfter?: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBe(30);
  });

  it("maps Slack 5xx to slack_api_error", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ status: 503, body: "" });

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slack_api_error");
  });

  it("returns empty_message_after_sanitization when sanitized text is empty", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "strip" },
    });

    const res = await callHandler({ channel: "#ops", text: "<!channel>" });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("empty_message_after_sanitization");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips broadcasts, sanitizes links, applies mentions policy, and reports metadata", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "strip" },
    });
    mockSlackResponse({
      body: { ok: true, channel: "C1", ts: "12345.67890" },
    });
    mockSlackResponse({
      body: {
        ok: true,
        permalink: "https://x.slack.com/archives/C1/p1234567890",
        channel: "C1",
      },
    });

    const text = "<!here> hi <@U999> see <https://evil|github.com>";
    const res = await callHandler({ channel: "#ops", text });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      strippedBroadcasts: boolean;
      mentionsModified: boolean;
      truncated: boolean;
      channelInput: string;
      permalink: string;
    };
    expect(body.ok).toBe(true);
    expect(body.strippedBroadcasts).toBe(true);
    expect(body.mentionsModified).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.channelInput).toBe("#ops");
    expect(body.permalink).toBe("https://x.slack.com/archives/C1/p1234567890");

    const slackCall = fetchMock.mock.calls[0];
    const slackUrl = (slackCall[0] as URL | string).toString();
    expect(slackUrl).toContain("chat.postMessage");
    const sentBody = JSON.parse(slackCall[1].body as string) as {
      channel: string;
      text: string;
    };
    expect(sentBody.channel).toBe("#ops");
    expect(sentBody.text).not.toContain("<!here>");
    expect(sentBody.text).not.toContain("<@U999>");
    expect(sentBody.text).toContain("https://evil");
    expect(sentBody.text).not.toContain("|github.com>");
  });

  it("returns the success envelope (no events emitted) and logs attribution on success", async () => {
    seedActiveSession({
      parentSessionId: "parent-1",
      spawnSource: "agent",
      userId: "user-42",
    });
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({
      body: { ok: true, channel: "C1", ts: "12345.67890" },
    });
    mockSlackResponse({
      body: {
        ok: true,
        permalink: "https://x.slack.com/archives/C1/p1234567890",
        channel: "C1",
      },
    });

    const res = await callHandler({
      channel: "#ops",
      text: "Migration complete",
      reason: "user asked",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.channelInput).toBe("#ops");
    expect(body.channelId).toBe("C1");
    expect(body.messageTs).toBe("12345.67890");
    expect(body.permalink).toBe("https://x.slack.com/archives/C1/p1234567890");
    // Attribution belongs in audit logs only — must not leak to the agent.
    expect(body).not.toHaveProperty("attribution");

    expect(sessionFetchMock).not.toHaveBeenCalled();

    const logEntry = lastLogPayload(consoleLogSpy, "Slack notification posted");
    expect(logEntry).toBeDefined();
    expect(logEntry?.parent_session_id).toBe("parent-1");
    expect(logEntry?.trigger_source).toBe("agent");
    expect(logEntry?.prompt_author_user_id).toBe("user-42");
    expect(logEntry?.repo).toBe("acme/web-app");
    expect(logEntry?.channel_id).toBe("C1");
    expect(logEntry?.request_reason).toBe("user asked");
  });

  it("logs an audit warning with attribution on Slack-side denial (no events emitted)", async () => {
    seedActiveSession({
      parentSessionId: "parent-2",
      spawnSource: "agent",
      userId: "user-99",
    });
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: false, error: "channel_not_found" } });

    await callHandler({ channel: "#nope", text: "hi" });

    expect(sessionFetchMock).not.toHaveBeenCalled();

    const logEntry = lastLogPayload(consoleWarnSpy, "Slack notification denied");
    expect(logEntry).toBeDefined();
    expect(logEntry?.reason).toBe("channel_not_found_or_forbidden");
    expect(logEntry?.parent_session_id).toBe("parent-2");
    expect(logEntry?.trigger_source).toBe("agent");
    expect(logEntry?.prompt_author_user_id).toBe("user-99");
    expect(logEntry?.request_reason).toBeNull();
  });

  it("passes channel input verbatim to Slack — channel ID", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C01ABC", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p" } });

    await callHandler({ channel: "C01ABC", text: "hi" });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      channel: string;
    };
    expect(sentBody.channel).toBe("C01ABC");
  });

  it("passes channel input verbatim to Slack — name with hash", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C123", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p" } });

    await callHandler({ channel: "#ops", text: "hi" });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      channel: string;
    };
    expect(sentBody.channel).toBe("#ops");
  });

  it("does not call Slack when feature is disabled", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: false, mentionsPolicy: "allow" },
    });

    await callHandler({ channel: "#ops", text: "hi" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Slack network/fetch failures to slack_api_error", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    // Shared slackFetch wraps fetch() in try/catch and returns
    // { ok: false, error: "network_error" } on TypeError. The handler must
    // map that to slack_api_error rather than letting the rejection escape.
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slack_api_error");
    expect(sessionFetchMock).not.toHaveBeenCalled();
  });

  it("rejects raw text longer than the input cap", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });

    const oversized = "a".repeat(12_001);
    const res = await callHandler({ channel: "#ops", text: oversized });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("invalid_input");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionFetchMock).not.toHaveBeenCalled();
  });
});
