import { describe, expect, it, vi, beforeEach } from "vitest";
import type * as SharedModule from "@open-inspect/shared";
import type { Env } from "./types";

const {
  mockVerifySlackSignature,
  mockAuthTest,
  mockGetChannelInfo,
  mockGetPermalink,
  mockAddReaction,
} = vi.hoisted(() => ({
  mockVerifySlackSignature: vi.fn(),
  mockAuthTest: vi.fn(),
  mockGetChannelInfo: vi.fn(),
  mockGetPermalink: vi.fn(),
  mockAddReaction: vi.fn(),
}));

vi.mock("@open-inspect/shared", async () => {
  const actual = await vi.importActual<typeof SharedModule>("@open-inspect/shared");
  return {
    ...actual, // keep the real normalizeSlackEvent, internal-auth helpers, cache store
    verifySlackSignature: mockVerifySlackSignature,
    authTest: mockAuthTest,
    getChannelInfo: mockGetChannelInfo,
    getPermalink: mockGetPermalink,
    addReaction: mockAddReaction,
  };
});

import app from "./index";
import { clearLocalCache } from "./classifier/repos";
import { clearBotUserIdCache } from "./bot-identity";

const BOT_USER_ID = "UBOT123";

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) return null;
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

/** Control-plane fetch mock: serves the watched-channel set and records forwards. */
function makeControlPlaneFetch(
  watched: string[],
  triggered: number,
  steered: number,
  forwardResponse?: unknown
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/integration-settings/slack/watched-channels")) {
      return new Response(JSON.stringify({ channels: watched }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/internal/slack-event")) {
      const skipped = triggered === 0 && steered === 0 ? 1 : 0;
      return new Response(
        JSON.stringify(forwardResponse ?? { ok: true, triggered, skipped, steered }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function makeEnv(
  opts: {
    triggersEnabled?: boolean;
    watched?: string[];
    triggered?: number;
    steered?: number;
    forwardResponse?: unknown;
  } = {}
): Env {
  return {
    SLACK_KV: createMockKV() as unknown as KVNamespace,
    CONTROL_PLANE: {
      fetch: makeControlPlaneFetch(
        opts.watched ?? ["C123"],
        opts.triggered ?? 1,
        opts.steered ?? 0,
        opts.forwardResponse
      ),
    } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "secret",
    SERVICE_AUTH_SECRET: "internal-secret",
    SLACK_TRIGGERS_ENABLED: opts.triggersEnabled ? "true" : undefined,
  } as unknown as Env;
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

async function flushWaitUntil(ctx: ReturnType<typeof makeCtx>, callIndex = 0): Promise<void> {
  await ctx.waitUntil.mock.calls[callIndex]?.[0];
}

function channelMessageRequest(event: Record<string, unknown>): Request {
  return new Request("http://localhost/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
    },
    body: JSON.stringify({
      type: "event_callback",
      event_id: crypto.randomUUID(),
      event_time: Math.floor(Date.now() / 1000),
      team_id: "T123",
      event: {
        type: "message",
        channel_type: "channel",
        channel: "C123",
        ts: "1700000000.000100",
        user: "U999",
        text: "the deploy job keeps failing",
        ...event,
      },
    }),
  });
}

function forwardedSlackEvents(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input).includes("/internal/slack-event"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

describe("channel-message automation triggers (POST /events)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalCache();
    clearBotUserIdCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockAuthTest.mockResolvedValue({ ok: true, user_id: BOT_USER_ID });
    mockGetChannelInfo.mockResolvedValue({ ok: true, channel: { id: "C123", name: "ops" } });
    mockGetPermalink.mockResolvedValue({
      ok: true,
      permalink: "https://slack.com/archives/C123/p1700000000000100",
    });
    mockAddReaction.mockResolvedValue({ ok: true });
  });

  it("forwards a normalized event for a candidate message in a watched channel", async () => {
    const env = makeEnv({ triggersEnabled: true, watched: ["C123"] });
    const ctx = makeCtx();

    const res = await app.fetch(channelMessageRequest({}), env, ctx);
    expect(res.status).toBe(200);
    await flushWaitUntil(ctx);

    const forwarded = forwardedSlackEvents(
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: readonly (readonly unknown[])[] } }
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      source: "slack",
      channelId: "C123",
      channelName: "ops",
      actorUserId: "U999",
      text: "the deploy job keeps failing",
      triggerKey: "slack:msg:C123:1700000000.000100",
    });

    // A run materialized → mark the triggering message with 👀.
    expect(mockAddReaction).toHaveBeenCalledWith("xoxb-test", "C123", "1700000000.000100", "eyes");
  });

  it("does not react when the forward matches no automation (triggered: 0)", async () => {
    const env = makeEnv({ triggersEnabled: true, watched: ["C123"], triggered: 0 });
    const ctx = makeCtx();

    await app.fetch(channelMessageRequest({}), env, ctx);
    await flushWaitUntil(ctx);

    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it("reacts when a follow-up steers an active run (triggered: 0, steered: 1)", async () => {
    const env = makeEnv({ triggersEnabled: true, watched: ["C123"], triggered: 0, steered: 1 });
    const ctx = makeCtx();

    // A reply in an active thread is forwarded and steers the running session;
    // the bot still marks the follow-up message with 👀.
    const res = await app.fetch(
      channelMessageRequest({ ts: "1700000000.000200", thread_ts: "1700000000.000100" }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(mockAddReaction).toHaveBeenCalledWith("xoxb-test", "C123", "1700000000.000200", "eyes");
  });

  it("does not react when the control-plane forward response is malformed", async () => {
    const env = makeEnv({
      triggersEnabled: true,
      watched: ["C123"],
      forwardResponse: { triggered: "1", skipped: 0, steered: 0 },
    });
    const ctx = makeCtx();

    await app.fetch(channelMessageRequest({}), env, ctx);
    await flushWaitUntil(ctx);

    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it("does not forward when the kill switch is off (default)", async () => {
    const env = makeEnv({ triggersEnabled: false, watched: ["C123"] });
    const ctx = makeCtx();

    await app.fetch(channelMessageRequest({}), env, ctx);
    await flushWaitUntil(ctx);

    const forwarded = forwardedSlackEvents(
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: readonly (readonly unknown[])[] } }
    );
    expect(forwarded).toHaveLength(0);
    // auth.test isn't even reached when the feature is dark.
    expect(mockAuthTest).not.toHaveBeenCalled();
  });

  it("does not forward a message in an unwatched channel", async () => {
    const env = makeEnv({ triggersEnabled: true, watched: ["C-other"] });
    const ctx = makeCtx();

    await app.fetch(channelMessageRequest({}), env, ctx);
    await flushWaitUntil(ctx);

    const forwarded = forwardedSlackEvents(
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: readonly (readonly unknown[])[] } }
    );
    expect(forwarded).toHaveLength(0);
  });

  it("suppresses a message that mentions the bot (handled by app_mention)", async () => {
    const env = makeEnv({ triggersEnabled: true, watched: ["C123"] });
    const ctx = makeCtx();

    await app.fetch(channelMessageRequest({ text: `<@${BOT_USER_ID}> please deploy` }), env, ctx);
    await flushWaitUntil(ctx);

    const forwarded = forwardedSlackEvents(
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: readonly (readonly unknown[])[] } }
    );
    expect(forwarded).toHaveLength(0);
  });
});
