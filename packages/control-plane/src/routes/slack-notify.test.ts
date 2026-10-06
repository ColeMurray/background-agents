import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { SECTION_TEXT_MAX_CHARS } from "@open-inspect/shared/slack";
import type * as SlackNotify from "./slack-notify";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { fakeSessionRuntimeDispatch, TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

const sessionStoreMock = {
  get: vi.fn(),
};
const channelBindingStoreMock = { get: vi.fn() };
const listChannelsMock = vi.hoisted(() => vi.fn());

vi.mock("@open-inspect/shared/slack", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, listChannels: listChannelsMock };
});

vi.mock("../db/team-channel-bindings", () => ({
  TeamChannelBindingStore: vi.fn().mockImplementation(function () {
    return channelBindingStoreMock;
  }),
}));

const integrationStoreMock = {
  getResolvedConfig: vi.fn(),
  getGlobal: vi.fn(),
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
let handleSlackNotify: typeof SlackNotify.handleSlackNotify;

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db: {} as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    metrics: {
      sqlQueries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(overrides?: Partial<Env>): Env {
  return {
    DB: {} as SqlDatabase,
    SESSION: fakeSessionRuntimeDispatch((request) => sessionFetchMock(request)),
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "test-key",
    SLACK_BOT_TOKEN: "xoxb-test",
    APP_NAME: "Open-Inspect",
    WEB_APP_URL: "https://app.example.com",
    ...overrides,
  } as Env;
}

async function callHandler(body: unknown, envOverrides?: Partial<Env>): Promise<Response> {
  const params = { id: PATH.match(PATTERN)!.groups!.id };
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handleSlackNotify(
    new Request(`https://test.local${PATH}`, init),
    createEnv(envOverrides),
    params,
    createCtx()
  );
}

function seedActiveSession(opts?: {
  parentSessionId?: string | null;
  spawnSource?: string;
  userId?: string | null;
  status?: SessionStatus;
  repoOwner?: string | null;
  repoName?: string | null;
  ownerTeamId?: string | null;
  visibility?: SessionVisibility;
}) {
  sessionStoreMock.get.mockResolvedValue({
    id: "sess-1",
    title: "Test session",
    repoOwner: opts && "repoOwner" in opts ? opts.repoOwner : "acme",
    repoName: opts && "repoName" in opts ? opts.repoName : "web-app",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: null,
    status: opts?.status ?? "active",
    ownerTeamId: opts && "ownerTeamId" in opts ? opts.ownerTeamId : "team-a",
    visibility: opts?.visibility ?? "workspace",
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

beforeEach(async () => {
  vi.resetModules();
  ({ handleSlackNotify } = await import("./slack-notify"));
  vi.clearAllMocks();
  channelBindingStoreMock.get.mockResolvedValue({ teamId: "team-a" });
  listChannelsMock.mockResolvedValue({
    ok: true,
    channels: [
      { id: "C1", name: "ops", isMember: true, isPrivate: false },
      { id: "C2", name: "nope", isMember: true, isPrivate: false },
      { id: "C3", name: "archive", isMember: true, isPrivate: false },
    ],
  });
  sessionFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
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
  describe("channel-name cache", () => {
    beforeEach(() => {
      seedActiveSession();
      integrationStoreMock.getResolvedConfig.mockResolvedValue({
        settings: { agentNotificationsEnabled: true },
      });
      fetchMock.mockImplementation(async () =>
        Response.json({
          ok: true,
          channel: "C1",
          ts: "1.2",
          permalink: "https://x.slack.com/p",
        })
      );
    });

    it("populates names from the listing for subsequent channel lookups", async () => {
      expect((await callHandler({ channel: "#ops", text: "Done" })).status).toBe(200);
      expect((await callHandler({ channel: "#archive", text: "Done" })).status).toBe(200);
      expect(listChannelsMock).toHaveBeenCalledOnce();
      expect(channelBindingStoreMock.get).toHaveBeenLastCalledWith("slack", "C3");
    });

    it("does not reuse another bot token's channel IDs", async () => {
      listChannelsMock.mockImplementation(async (token: string) => ({
        ok: true,
        channels: [{ id: token === "xoxb-test" ? "C1" : "CSECOND", name: "ops" }],
      }));
      expect((await callHandler({ channel: "#ops", text: "Done" })).status).toBe(200);
      expect(
        (await callHandler({ channel: "ops", text: "Done" }, { SLACK_BOT_TOKEN: "xoxb-second" }))
          .status
      ).toBe(200);
      expect(listChannelsMock).toHaveBeenCalledTimes(2);
      expect(channelBindingStoreMock.get).toHaveBeenLastCalledWith("slack", "CSECOND");
    });

    it("refreshes expired entries rather than extending their TTL on a hit", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const nowMs = Date.parse("2026-10-01T00:00:00Z");
      vi.setSystemTime(nowMs);
      expect((await callHandler({ channel: "#OPS", text: "Done" })).status).toBe(200);
      vi.setSystemTime(nowMs + 59_999);
      expect((await callHandler({ channel: "ops", text: "Done" })).status).toBe(200);
      expect(listChannelsMock).toHaveBeenCalledOnce();
      expect(channelBindingStoreMock.get).toHaveBeenLastCalledWith("slack", "C1");
      listChannelsMock.mockResolvedValue({ ok: true, channels: [{ id: "CNEW", name: "ops" }] });
      vi.setSystemTime(nowMs + 60_000);
      expect((await callHandler({ channel: "#ops", text: "Done" })).status).toBe(200);
      expect(listChannelsMock).toHaveBeenCalledTimes(2);
      expect(channelBindingStoreMock.get).toHaveBeenLastCalledWith("slack", "CNEW");
      expect(sessionStoreMock.get).toHaveBeenCalledTimes(6);
      expect(channelBindingStoreMock.get).toHaveBeenCalledTimes(3);
    });

    it("bounds the cache while retaining the requested name from a large listing", async () => {
      listChannelsMock.mockResolvedValue({
        ok: true,
        channels: Array.from({ length: 1001 }, (_, index) => ({
          id: `C${index}`,
          name: `channel-${index}`,
        })),
      });
      expect((await callHandler({ channel: "channel-0", text: "Done" })).status).toBe(200);
      expect((await callHandler({ channel: "channel-0", text: "Done" })).status).toBe(200);
      expect(listChannelsMock).toHaveBeenCalledOnce();
      expect((await callHandler({ channel: "channel-1", text: "Done" })).status).toBe(200);
      expect(listChannelsMock).toHaveBeenCalledTimes(2);
    });

    it.each([null, { teamId: "team-b" }])(
      "checks the current binding %j even when the channel name is cached",
      async (binding) => {
        expect((await callHandler({ channel: "#ops", text: "Done" })).status).toBe(200);
        channelBindingStoreMock.get.mockResolvedValue(binding);
        fetchMock.mockClear();
        const refused = await callHandler({ channel: "ops", text: "secret text" });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: "session_scope_denied" });
        expect(listChannelsMock).toHaveBeenCalledOnce();
        expect(channelBindingStoreMock.get).toHaveBeenCalledTimes(2);
        expect(channelBindingStoreMock.get).toHaveBeenLastCalledWith("slack", "C1");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(sessionFetchMock).not.toHaveBeenCalled();
      }
    );

    it("does not cache failed listings or missing names", async () => {
      listChannelsMock.mockResolvedValueOnce({ ok: false, error: "ratelimited", retryAfter: 30 });
      const limited = await callHandler({ channel: "ops", text: "Done" });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({
        error: "rate_limited",
        message: "ratelimited",
        retryAfter: 30,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(channelBindingStoreMock.get).not.toHaveBeenCalled();
      expect((await callHandler({ channel: "ops", text: "Done" })).status).toBe(200);
      fetchMock.mockClear();
      channelBindingStoreMock.get.mockClear();
      for (const channel of ["#missing", "missing"]) {
        const missing = await callHandler({ channel, text: "Done" });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({
          error: "channel_not_found_or_forbidden",
          message: "Slack channel was not found.",
        });
      }
      expect(listChannelsMock).toHaveBeenCalledTimes(4);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(channelBindingStoreMock.get).not.toHaveBeenCalled();
    });
  });

  it("refuses a missing authoritative session before bot configuration", async () => {
    sessionStoreMock.get.mockResolvedValue(null);

    const res = await callHandler(
      { channel: "C1", text: "secret text" },
      { SLACK_BOT_TOKEN: undefined }
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_input" });
    expect(listChannelsMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses private sessions before bot token or settings lookup", async () => {
    seedActiveSession({ visibility: "private" });

    const res = await callHandler(
      { channel: "#ops", text: "secret text" },
      { SLACK_BOT_TOKEN: undefined }
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "session_scope_denied" });
    expect(integrationStoreMock.getGlobal).not.toHaveBeenCalled();
    expect(integrationStoreMock.getResolvedConfig).not.toHaveBeenCalled();
    expect(listChannelsMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when name resolution races a session becoming private", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      settings: { agentNotificationsEnabled: true },
    });
    listChannelsMock.mockImplementationOnce(async () => {
      seedActiveSession({ visibility: "private" });
      return { ok: true, channels: [{ id: "C1", name: "ops" }] };
    });

    const res = await callHandler({ channel: "#ops", text: "secret text" });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the session disappears during channel name resolution", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      settings: { agentNotificationsEnabled: true },
    });
    listChannelsMock.mockImplementationOnce(async () => {
      sessionStoreMock.get.mockResolvedValue(null);
      return { ok: true, channels: [{ id: "C1", name: "ops" }] };
    });

    const res = await callHandler({ channel: "#ops", text: "secret text" });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows workspace sessions in unbound channels", async () => {
    seedActiveSession({ ownerTeamId: null });
    channelBindingStoreMock.get.mockResolvedValue(null);
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      settings: { agentNotificationsEnabled: true },
    });
    mockSlackResponse({ body: { ok: true, channel: "C1", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, channel: "C1", permalink: "https://x.slack.com/p" } });

    expect((await callHandler({ channel: "C1", text: "Done" })).status).toBe(200);
  });

  it.each(["CNEVERBOUND", "D1"])(
    "refuses team sessions in unbound targets including DMs: %s",
    async (channel) => {
      seedActiveSession();
      channelBindingStoreMock.get.mockResolvedValue(null);
      integrationStoreMock.getResolvedConfig.mockResolvedValue({
        settings: { agentNotificationsEnabled: true },
      });

      const response = await callHandler({ channel, text: "secret text" });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "session_scope_denied" });
      expect(channelBindingStoreMock.get).toHaveBeenCalledWith("slack", channel);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

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

  it("splits a long message and lets Slack derive accessible fallback text", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "strip" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C1", ts: "12345.67890" } });
    mockSlackResponse({
      body: { ok: true, permalink: "https://x.slack.com/archives/C1/p1", channel: "C1" },
    });

    // Findings then recommendations: the tail is the part a reader needs, and
    // it is exactly what a hard cut used to remove.
    const findings = Array.from({ length: 40 }, (_, i) => `Finding ${i}: ${"x".repeat(70)}`).join(
      "\n\n"
    );
    const text = `${findings}\n\nRECOMMENDATION: do the thing.`;
    expect(text.length).toBeGreaterThan(SECTION_TEXT_MAX_CHARS);

    const res = await callHandler({ channel: "#ops", text });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { truncated: boolean }).truncated).toBe(false);

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    expect(body).not.toHaveProperty("text");
    const sections = body.blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.text!.text.length).toBeLessThanOrEqual(SECTION_TEXT_MAX_CHARS);
    }
    // Nothing lost: the closing recommendation survives.
    expect(sections.map((b) => b.text!.text).join("")).toContain("RECOMMENDATION: do the thing.");
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
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    expect(sentBody.channel).toBe("C1");
    const sentText = sentBody.blocks.find((block) => block.type === "section")?.text?.text ?? "";
    expect(sentText).not.toContain("<!here>");
    expect(sentText).not.toContain("<@U999>");
    expect(sentText).toContain("https://evil");
    expect(sentText).not.toContain("|github.com>");
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

  it("uses global settings and a null repo audit field for no-repo sessions", async () => {
    seedActiveSession({
      parentSessionId: "parent-1",
      spawnSource: "automation",
      userId: "user-42",
      repoOwner: null,
      repoName: null,
    });
    integrationStoreMock.getGlobal.mockResolvedValue({
      defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
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

    const res = await callHandler({ channel: "#ops", text: "Done" });

    expect(res.status).toBe(200);
    expect(integrationStoreMock.getGlobal).toHaveBeenCalledWith("slack");
    expect(integrationStoreMock.getResolvedConfig).not.toHaveBeenCalled();

    const logEntry = lastLogPayload(consoleLogSpy, "Slack notification posted");
    expect(logEntry).toBeDefined();
    expect(logEntry?.repo).toBeNull();
  });

  it("uses global wording when global Slack settings disable notifications", async () => {
    seedActiveSession({
      spawnSource: "automation",
      repoOwner: null,
      repoName: null,
    });
    integrationStoreMock.getGlobal.mockResolvedValue({
      defaults: { agentNotificationsEnabled: false, mentionsPolicy: "allow" },
    });

    const res = await callHandler({ channel: "#ops", text: "Done" });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "feature_disabled",
      message: "Slack agent notifications are disabled globally.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(integrationStoreMock.getGlobal).toHaveBeenCalledWith("slack");
    expect(integrationStoreMock.getResolvedConfig).not.toHaveBeenCalled();
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

  it("passes a channel ID without a Slack channel lookup", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C01ABC", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    await callHandler({ channel: "C01ABC", text: "hi" });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      channel: string;
    };
    expect(sentBody.channel).toBe("C01ABC");
    expect(listChannelsMock).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "resolves names before binding checks and posting (permalink channel: %s)",
    async (hasPermalinkChannel) => {
      seedActiveSession({ visibility: "team" });
      channelBindingStoreMock.get.mockResolvedValue({ teamId: "team-a" });
      integrationStoreMock.getResolvedConfig.mockResolvedValue({
        enabledRepos: null,
        settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
      });
      mockSlackResponse({ body: { ok: true, channel: "C123", ts: "1.2" } });
      mockSlackResponse({
        body: {
          ok: true,
          permalink: "https://x.slack.com/p",
          ...(hasPermalinkChannel ? { channel: "C1" } : {}),
        },
      });

      const response = await callHandler({ channel: "#ops", text: "hi" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        channelId: "C123",
        messageTs: "1.2",
        permalink: hasPermalinkChannel ? "https://x.slack.com/p" : "",
      });
      const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
        channel: string;
      };
      expect(sentBody.channel).toBe("C1");
      expect(listChannelsMock).toHaveBeenCalledWith("xoxb-test", {
        signal: expect.any(AbortSignal),
      });
      expect(channelBindingStoreMock.get).toHaveBeenCalledWith("slack", "C1");
    }
  );

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

  it("returns a deterministic Slack API error when posting times out", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });

    const responsePromise = callHandler({ channel: "#ops", text: "hello" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    timeout.abort(new DOMException("deadline exceeded", "TimeoutError"));

    const res = await responsePromise;
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      error: "delivery_unknown",
      message: "delivery_unknown",
    });
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
