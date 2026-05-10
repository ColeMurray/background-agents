import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { IntegrationSettingsStore } from "../../src/db/integration-settings";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO, seedSandboxAuth } from "./helpers";

async function setupSession(opts?: {
  agentNotificationsEnabled?: boolean;
  mentionsPolicy?: "allow" | "escape" | "strip";
  parentSessionId?: string | null;
  spawnSource?: "user" | "agent";
  userId?: string;
}) {
  const sessionName = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { stub } = await initNamedSession(sessionName, {
    repoOwner: "acme",
    repoName: "web-app",
    userId: opts?.userId ?? "user-1",
  });

  const sandboxToken = `sb-tok-${Date.now()}`;
  await seedSandboxAuth(stub, {
    authToken: sandboxToken,
    sandboxId: `sb-${Date.now()}`,
  });

  const sessionStore = new SessionIndexStore(env.DB);
  const now = Date.now();
  await sessionStore.create({
    id: sessionName,
    title: "Test session",
    repoOwner: "acme",
    repoName: "web-app",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: null,
    status: "active",
    parentSessionId: opts?.parentSessionId ?? null,
    spawnSource: opts?.spawnSource ?? "user",
    spawnDepth: 0,
    userId: opts?.userId ?? "user-1",
    createdAt: now,
    updatedAt: now,
  });

  if (opts?.agentNotificationsEnabled !== undefined || opts?.mentionsPolicy !== undefined) {
    const store = new IntegrationSettingsStore(env.DB);
    await store.setGlobal("slack", {
      defaults: {
        agentNotificationsEnabled: opts?.agentNotificationsEnabled ?? false,
        mentionsPolicy: opts?.mentionsPolicy ?? "allow",
      },
    });
  }

  return { sessionName, stub, sandboxToken };
}

function buildSlackFetchMock(handlers: {
  postMessage?: () => Response;
  getPermalink?: () => Response;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("chat.postMessage")) {
      return handlers.postMessage
        ? handlers.postMessage()
        : new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }), { status: 200 });
    }
    if (url.includes("chat.getPermalink")) {
      return handlers.getPermalink
        ? handlers.getPermalink()
        : new Response(
            JSON.stringify({
              ok: true,
              permalink: "https://x.slack.com/archives/C1/p12",
              channel: "C1",
            }),
            { status: 200 }
          );
    }
    throw new Error(`Unmocked fetch: ${url}`);
  });
}

describe("POST /sessions/:id/slack-notify", () => {
  beforeEach(cleanD1Tables);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 without sandbox auth", async () => {
    const { sessionName } = await setupSession({ agentNotificationsEnabled: true });

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "#ops", text: "hi" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 403 feature_disabled when master switch is off", async () => {
    const { sessionName, sandboxToken } = await setupSession({
      agentNotificationsEnabled: false,
    });

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({ channel: "#ops", text: "hi" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("feature_disabled");
  });

  it("returns the success envelope and persists no events of its own", async () => {
    const { sessionName, sandboxToken, stub } = await setupSession({
      agentNotificationsEnabled: true,
      mentionsPolicy: "allow",
      spawnSource: "agent",
    });

    vi.stubGlobal("fetch", buildSlackFetchMock({}));

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        channel: "#ops",
        text: "Migration complete",
        reason: "user asked",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      channelInput: string;
      channelId: string;
      messageTs: string;
      permalink: string;
    }>();
    expect(body.ok).toBe(true);
    expect(body.channelInput).toBe("#ops");
    expect(body.channelId).toBe("C1");
    expect(body.permalink).toContain("slack.com");

    // The agent's tool_call (emitted by OpenCode in the sandbox) is the
    // single source of truth for the transcript — the handler must not
    // inject synthetic tool_call/tool_result events of its own.
    const slackEvents = await queryDO<{ type: string; data: string }>(
      stub,
      "SELECT type, data FROM events WHERE data LIKE '%slack-notify%' ORDER BY created_at"
    );
    expect(slackEvents).toHaveLength(0);
  });

  it("maps Slack channel_not_found to 404 channel_not_found_or_forbidden", async () => {
    const { sessionName, sandboxToken } = await setupSession({
      agentNotificationsEnabled: true,
    });

    vi.stubGlobal(
      "fetch",
      buildSlackFetchMock({
        postMessage: () =>
          new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
      })
    );

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({ channel: "#nope", text: "hi" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("channel_not_found_or_forbidden");
  });

  it("passes channel verbatim to Slack — both name and ID forms", async () => {
    const { sessionName, sandboxToken } = await setupSession({
      agentNotificationsEnabled: true,
    });

    let capturedChannel: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("chat.postMessage")) {
          const body = init?.body ? JSON.parse(init.body as string) : {};
          capturedChannel = body.channel as string;
          return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }), {
            status: 200,
          });
        }
        if (url.includes("chat.getPermalink")) {
          return new Response(
            JSON.stringify({ ok: true, permalink: "https://x.slack.com/p", channel: "C1" }),
            { status: 200 }
          );
        }
        throw new Error(`Unmocked fetch: ${url}`);
      })
    );

    await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({ channel: "C01ABC", text: "hi" }),
    });
    expect(capturedChannel).toBe("C01ABC");
  });
});
