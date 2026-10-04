import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF, createExecutionContext, env } from "cloudflare:test";
import { IntegrationSettingsStore } from "../../src/db/integration-settings";
import { SessionIndexStore } from "../../src/db/session-index";
import { TeamChannelBindingStore } from "../../src/db/team-channel-bindings";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, queryDO, routeRequest, seedSandboxAuth } from "./helpers";

async function setupSession(opts?: {
  agentNotificationsEnabled?: boolean;
  mentionsPolicy?: "allow" | "escape" | "strip";
  parentSessionId?: string | null;
  spawnSource?: "user" | "agent";
  userId?: string;
  ownerTeamId?: string | null;
  visibility?: SessionVisibility;
}) {
  const sessionName = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { stub } = await initNamedSessionDO(sessionName, {
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
    ownerTeamId: opts?.ownerTeamId ?? null,
    visibility: opts?.visibility ?? "workspace",
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
  listChannels?: () => Response;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("conversations.list")) {
      return handlers.listChannels
        ? handlers.listChannels()
        : Response.json({
            ok: true,
            channels: [
              { id: "C1", name: "ops", is_member: true },
              { id: "C2", name: "nope", is_member: true },
            ],
          });
    }
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
    vi.restoreAllMocks();
  });

  it("does not post when the authoritative session is missing", async () => {
    const { sessionName, sandboxToken } = await setupSession({ agentNotificationsEnabled: true });
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionName).run();
    const slackFetch = vi.fn();
    vi.stubGlobal("fetch", slackFetch);

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sandboxToken}` },
      body: JSON.stringify({ channel: "C1", text: "secret text" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_input" });
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it("refuses a private session through the sandbox-authenticated route", async () => {
    const { sessionName, sandboxToken } = await setupSession({
      visibility: "private",
      agentNotificationsEnabled: true,
    });
    const slackFetch = vi.fn();
    vi.stubGlobal("fetch", slackFetch);

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sandboxToken}` },
      body: JSON.stringify({ channel: "#ops", text: "secret text" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "session_scope_denied" });
    expect(slackFetch).not.toHaveBeenCalled();
  });

  it.each(["team", "workspace"] as const)(
    "refuses %s-visible cross-team posts after resolving names to channel IDs",
    async (visibility) => {
      for (const teamId of ["team-a", "team-b"]) {
        await env.DB.prepare(
          "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
        )
          .bind(teamId, teamId, teamId)
          .run();
      }
      await env.DB.prepare(
        "INSERT INTO team_channel_bindings (provider, external_id, team_id, kind, created_at) VALUES ('slack', 'C1', 'team-b', 'source', 1)"
      ).run();
      const { sessionName, sandboxToken } = await setupSession({
        ownerTeamId: "team-a",
        visibility,
        agentNotificationsEnabled: true,
      });
      const channelName = `${visibility}-ops`;
      const slackFetch = buildSlackFetchMock({
        listChannels: () =>
          Response.json({ ok: true, channels: [{ id: "C1", name: channelName }] }),
      });
      vi.stubGlobal("fetch", slackFetch);

      for (const channel of ["C1", `#${channelName}`, channelName]) {
        const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
          method: "POST",
          headers: { Authorization: `Bearer ${sandboxToken}` },
          body: JSON.stringify({ channel, text: "secret text" }),
        });
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: "session_scope_denied" });
      }

      expect(slackFetch).toHaveBeenCalledOnce();
      for (const [input] of slackFetch.mock.calls) {
        expect(String(input)).toContain("conversations.list");
      }
    }
  );

  describe.each(["off", "shadow", "on"])("channel unbinding in %s mode", (mode) => {
    it.each(["team", "workspace"] as const)(
      "revokes %s-visible team posts and logs the refusal",
      async (visibility) => {
        await env.DB.prepare(
          "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', 1, 1)"
        ).run();
        const bindings = new TeamChannelBindingStore(env.DB);
        const actor = { actorUserId: "user-1", requestId: "slack-notify-unbind" };
        await bindings.put(
          { provider: "slack", externalId: "C1", teamId: "team-a", kind: "source" },
          actor
        );
        const { sessionName, sandboxToken } = await setupSession({
          ownerTeamId: "team-a",
          visibility,
          agentNotificationsEnabled: true,
        });
        const slackFetch = buildSlackFetchMock({});
        vi.stubGlobal("fetch", slackFetch);
        const notify = () =>
          routeRequest(
            new Request(`https://test.local/sessions/${sessionName}/slack-notify`, {
              method: "POST",
              headers: { Authorization: `Bearer ${sandboxToken}` },
              body: JSON.stringify({ channel: "C1", text: "secret text" }),
            }),
            { ...env, TEAMS_ENFORCEMENT: mode },
            createExecutionContext()
          );
        expect((await notify()).status).toBe(200);

        await bindings.remove("team-a", "slack", "C1", actor);
        slackFetch.mockClear();
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
        const refused = await notify();

        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: "session_scope_denied" });
        expect(slackFetch).not.toHaveBeenCalled();
        expect(warnings.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
          expect.objectContaining({
            event: "slack_notify.denial",
            session_id: sessionName,
            channel_input: "C1",
            reason: "session_scope_denied",
          })
        );
      }
    );
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

    // Handler must inject no transcript events — the agent's own tool_call is the source of truth.
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
});
