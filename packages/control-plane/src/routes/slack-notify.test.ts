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
    SessionIndexStore: vi.fn().mockImplementation(() => sessionStoreMock),
  };
});

vi.mock("../db/integration-settings", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    IntegrationSettingsStore: vi.fn().mockImplementation(() => integrationStoreMock),
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

async function emittedEvents(): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for (const call of sessionFetchMock.mock.calls) {
    const req = call[0] as Request;
    events.push((await req.clone().json()) as Record<string, unknown>);
  }
  return events;
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

beforeEach(() => {
  vi.clearAllMocks();
  sessionFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleSlackNotify", () => {
  it("returns 503 feature_unavailable when SLACK_BOT_TOKEN is missing", async () => {
    const res = await callHandler(
      { channel: "#ops", text: "hello" },
      { SLACK_BOT_TOKEN: undefined }
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("feature_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionFetchMock).not.toHaveBeenCalled();
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
    expect(sessionFetchMock).toHaveBeenCalledTimes(1);
    const events = await emittedEvents();
    const sentEvent = events[0];
    expect(sentEvent.type).toBe("tool_call");
    expect(sentEvent.tool).toBe("slack-notify");
    expect(sentEvent.status).toBe("error");
    expect(sentEvent.output).toBe("feature_disabled");
  });

  it("returns feature_disabled when repo override is false even if global is true", async () => {
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

  it("emits tool_call (completed) and tool_result events with attribution on success", async () => {
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
    expect(sessionFetchMock).toHaveBeenCalledTimes(2);
    const events = await emittedEvents();
    const [toolCall, toolResult] = events;
    expect(toolCall.type).toBe("tool_call");
    expect(toolCall.tool).toBe("slack-notify");
    expect(toolCall.status).toBe("completed");
    const args = toolCall.args as Record<string, unknown>;
    expect(args.channel).toBe("#ops");
    expect(args.reason).toBe("user asked");
    const output = JSON.parse(toolCall.output as string) as Record<string, unknown>;
    expect(output.channelId).toBe("C1");
    expect(output.messageTs).toBe("12345.67890");
    expect(output.permalink).toBe("https://x.slack.com/archives/C1/p1234567890");
    const attribution = output.attribution as Record<string, unknown>;
    expect(attribution.parentSessionId).toBe("parent-1");
    expect(attribution.triggerSource).toBe("agent");
    expect(attribution.promptAuthorUserId).toBe("user-42");

    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.callId).toBe(toolCall.callId);
  });

  it("emits a single failed tool_call event on Slack-side denial", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: false, error: "channel_not_found" } });

    await callHandler({ channel: "#nope", text: "hi" });

    expect(sessionFetchMock).toHaveBeenCalledTimes(1);
    const events = await emittedEvents();
    const sentEvent = events[0];
    expect(sentEvent.type).toBe("tool_call");
    expect(sentEvent.status).toBe("error");
    expect(sentEvent.output).toBe("channel_not_found_or_forbidden");
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
});
