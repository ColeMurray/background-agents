import { env } from "cloudflare:test";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptToken } from "../../src/auth/crypto";
import { TeamStore } from "../../src/db/teams";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSession,
  openClientWs,
  queryDO,
  seedEvents,
  serviceFetch,
  waitForSandboxStatus,
} from "./helpers";
import { makeRunRow, seedRun } from "./run-helpers";

describe("session snapshot synchronization", () => {
  beforeEach(cleanD1Tables);

  it.each(["22222222222222222222222222222222", null])(
    "returns the D1 ownerUserId for a private snapshot despite a stale DO owner (%s)",
    async (ownerUserId) => {
      const name = `snapshot-owner-${crypto.randomUUID()}`;
      const { stub } = await initNamedSession(name, { userId: "stale-runtime-owner" });
      await waitForSandboxStatus(stub, "failed");
      await env.DB.prepare("UPDATE sessions SET user_id = ?, visibility = 'private' WHERE id = ?")
        .bind(ownerUserId, name)
        .run();

      expect(
        await queryDO<{ user_id: string }>(
          stub,
          "SELECT user_id FROM participants WHERE role = 'owner'"
        )
      ).toEqual([{ user_id: "stale-runtime-owner" }]);

      const response = await serviceFetch(`https://test.local/sessions/${name}`);

      expect(response.status).toBe(200);
      const snapshot = await response.json<SessionSnapshot>();
      expect(snapshot.session).toMatchObject({
        ownerUserId,
        visibility: "private",
        capabilities: { canRead: true, canSandbox: false },
      });
    }
  );

  it("returns a secret-free snapshot with stable event identities", async () => {
    const name = `snapshot-${Date.now()}`;
    const { stub } = await initNamedSession(name, { title: "Snapshot session" });
    await waitForSandboxStatus(stub, "failed");
    const createdAt = Date.now();
    await seedEvents(stub, [
      {
        id: "stable-event-1",
        type: "git_sync",
        data: JSON.stringify({
          type: "git_sync",
          status: "completed",
          sandboxId: "sandbox-1",
          timestamp: createdAt,
        }),
        createdAt,
      },
    ]);
    await queryDO(
      stub,
      `UPDATE sandbox
       SET status = 'ready', code_server_url = ?, code_server_password = ?,
           vnc_url = ?, vnc_password = ?, ttyd_url = ?, ttyd_token = ?`,
      "https://code.example.test",
      await encryptToken("code-secret", env.REPO_SECRETS_ENCRYPTION_KEY!),
      "https://desktop.example.test",
      await encryptToken("vnc-secret", env.REPO_SECRETS_ENCRYPTION_KEY!),
      "https://terminal.example.test",
      await encryptToken("terminal-secret", env.REPO_SECRETS_ENCRYPTION_KEY!)
    );

    const response = await stub.fetch("http://internal/internal/snapshot");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const snapshot = await response.json<SessionSnapshot>();

    expect(snapshot.session).toMatchObject({
      id: name,
      codeServerUrl: "https://code.example.test",
      vncUrl: "https://desktop.example.test",
    });
    expect(snapshot.session).not.toHaveProperty("codeServerPassword");
    expect(snapshot.session).not.toHaveProperty("vncPassword");
    expect(snapshot.session).not.toHaveProperty("ttydToken");
    expect(snapshot.session).not.toHaveProperty("slackThread");
    expect(JSON.stringify(snapshot)).not.toContain("code-secret");
    expect(JSON.stringify(snapshot)).not.toContain("vnc-secret");
    expect(JSON.stringify(snapshot)).not.toContain("terminal-secret");
    expect(snapshot.timeline.events).toContainEqual({
      eventId: "stable-event-1",
      timelineSequence: expect.any(Number),
      event: expect.objectContaining({ type: "git_sync", status: "completed" }),
    });

    const sandboxAccessResponse = await stub.fetch("http://internal/internal/sandbox-access");
    expect(sandboxAccessResponse.status).toBe(200);
    expect(sandboxAccessResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await sandboxAccessResponse.json()).toEqual({
      codeServer: { url: "https://code.example.test", password: "code-secret" },
      vnc: { url: "https://desktop.example.test", password: "vnc-secret" },
      ttyd: { url: "https://terminal.example.test", token: "terminal-secret" },
      tunnelUrls: null,
      sandboxDashboardUrl: null,
    });

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    expect(messages!.map((message) => message.type)).toEqual(["subscribed"]);
    expect(messages![0].session).not.toHaveProperty("codeServerPassword");
    expect(messages![0].session).not.toHaveProperty("vncPassword");
    expect(messages![0].session).not.toHaveProperty("ttydToken");
    expect(messages![0].canManageBudget).toBe(true);
    expect(messages![0].timeline).toHaveProperty("events");
    expect(JSON.stringify(messages![0])).not.toContain("code-secret");
    expect(JSON.stringify(messages![0])).not.toContain("vnc-secret");
    expect(JSON.stringify(messages![0])).not.toContain("terminal-secret");

    const mappings = await queryDO<{ participant_id: string; client_id: string }>(
      stub,
      "SELECT participant_id, client_id FROM ws_client_mapping"
    );
    expect(mappings).toHaveLength(1);
    ws.close();

    await queryDO(stub, "UPDATE sandbox SET status = 'failed'");
    const unavailableSandboxAccess = await stub.fetch("http://internal/internal/sandbox-access");
    expect(unavailableSandboxAccess.status).toBe(409);
    expect(unavailableSandboxAccess.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("resolves current Slack channel bindings in HTTP and WebSocket snapshots", async () => {
    const name = `snapshot-slack-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    const firstTeam = await new TeamStore(env.DB).create({
      slug: "first-team",
      name: "First Team",
      joinPolicy: "invite_only",
    });
    const secondTeam = await new TeamStore(env.DB).create({
      slug: "second-team",
      name: "Second Team",
      joinPolicy: "invite_only",
    });
    await queryDO(
      stub,
      `INSERT INTO messages (id, author_id, content, source, status, callback_context, created_at)
       SELECT 'origin', id, 'Initial Slack prompt', 'slack', 'completed', ?, 1
       FROM participants WHERE role = 'owner'`,
      JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "123.456",
        repoFullName: "acme/web-app",
        model: "anthropic/claude-sonnet-4",
        teamId: "stale-callback-team",
      })
    );
    await env.DB.prepare(
      `INSERT INTO team_channel_bindings (provider, external_id, team_id, kind, created_at)
       VALUES ('linear', 'C123', ?, 'source', 1)`
    )
      .bind(firstTeam.id)
      .run();

    for (const teamId of [firstTeam.id, secondTeam.id, null]) {
      if (teamId) {
        await env.DB.prepare(
          `INSERT INTO team_channel_bindings (provider, external_id, team_id, kind, created_at)
           VALUES ('slack', 'C123', ?, 'source', 1)
           ON CONFLICT (provider, external_id) DO UPDATE SET team_id = excluded.team_id`
        )
          .bind(teamId)
          .run();
      } else {
        await env.DB.prepare(
          "DELETE FROM team_channel_bindings WHERE provider = 'slack' AND external_id = 'C123'"
        ).run();
      }

      const response = await serviceFetch(`https://test.local/sessions/${name}`);
      expect(response.status).toBe(200);
      const snapshot = await response.json<SessionSnapshot>();
      expect(snapshot.session.slackThread).toEqual({ channelId: "C123", teamId });
      expect(JSON.stringify(snapshot)).not.toContain("stale-callback-team");

      const { ws, messages } = await openClientWs(name, { subscribe: true });
      try {
        expect(messages[0]).toMatchObject({
          type: "subscribed",
          session: { slackThread: { channelId: "C123", teamId } },
        });
      } finally {
        ws.close();
      }
    }
  });

  it.each(["web", "automation", "slack"])(
    "does not infer a Slack origin from follow-ups after a %s first message with no callback",
    async (source) => {
      const name = `snapshot-no-slack-origin-${crypto.randomUUID()}`;
      const { stub } = await initNamedSession(name);
      await waitForSandboxStatus(stub, "failed");
      await queryDO(
        stub,
        `INSERT INTO messages (id, author_id, content, source, status, created_at)
         SELECT 'origin', id, 'Initial prompt', ?, 'completed', 1
         FROM participants WHERE role = 'owner'`,
        source
      );
      await queryDO(
        stub,
        `INSERT INTO messages (id, author_id, content, source, status, callback_context, created_at)
         SELECT 'followup', id, 'Slack follow-up', 'slack', 'completed', ?, 2
         FROM participants WHERE role = 'owner'`,
        JSON.stringify({
          source: "slack",
          channel: "C123",
          threadTs: "123.456",
          repoFullName: "acme/web-app",
          model: "anthropic/claude-sonnet-4",
        })
      );

      const response = await serviceFetch(`https://test.local/sessions/${name}`);
      expect(response.status).toBe(200);
      expect((await response.json<SessionSnapshot>()).session).not.toHaveProperty("slackThread");
      const { ws, messages } = await openClientWs(name, { subscribe: true });
      try {
        expect(messages[0]).toHaveProperty("type", "subscribed");
        expect(messages[0].session).not.toHaveProperty("slackThread");
      } finally {
        ws.close();
      }
    }
  );

  it.each(["slack", "github"])(
    "uses the stored %s automation invocation rather than a later Slack follow-up",
    async (provider) => {
      const name = `snapshot-automation-${crypto.randomUUID()}`;
      const { stub } = await initNamedSession(name, { spawnSource: "automation" });
      await waitForSandboxStatus(stub, "failed");
      await env.DB.prepare(
        `INSERT INTO automations
           (id, name, instructions, trigger_type, model, created_by, created_at, updated_at)
         VALUES ('automation-1', 'Automation', 'Investigate', ?, 'anthropic/claude-sonnet-4', 'user-1', 1, 1)`
      )
        .bind(`${provider}_event`)
        .run();
      const run = makeRunRow("automation-1", { session_id: name, status: "completed" });
      await seedRun(run);
      await env.DB.prepare(
        `UPDATE automation_invocations SET source = 'event', trigger_key = ?, trigger_metadata = ?
         WHERE id = ?`
      )
        .bind(
          provider === "slack" ? "slack:msg:C123:123.456" : "pr:1:opened:abc",
          JSON.stringify({ channel: "C123", messageTs: "123.456" }),
          run.invocation_id
        )
        .run();
      await queryDO(
        stub,
        `INSERT INTO messages (id, author_id, content, source, status, callback_context, created_at)
         SELECT 'origin', id, 'Automation prompt', 'automation', 'completed', ?, 1
         FROM participants WHERE role = 'owner'`,
        JSON.stringify({
          source: "automation",
          automationId: "automation-1",
          runId: run.id,
          automationName: "Automation",
        })
      );
      await queryDO(
        stub,
        `INSERT INTO messages (id, author_id, content, source, status, callback_context, created_at)
         SELECT 'followup', id, 'Slack follow-up', 'slack', 'completed', ?, 2
         FROM participants WHERE role = 'owner'`,
        JSON.stringify({
          source: "slack",
          channel: "C456",
          threadTs: "456.789",
          repoFullName: "acme/web-app",
          model: "anthropic/claude-sonnet-4",
        })
      );

      const response = await serviceFetch(`https://test.local/sessions/${name}`);
      expect(response.status).toBe(200);
      const snapshot = await response.json<SessionSnapshot>();
      const { ws, messages } = await openClientWs(name, { subscribe: true });
      try {
        expect(messages[0]).toHaveProperty("type", "subscribed");
        if (provider === "slack") {
          expect(snapshot.session.slackThread).toEqual({ channelId: "C123", teamId: null });
          expect(messages[0]).toMatchObject({
            session: { slackThread: { channelId: "C123", teamId: null } },
          });
        } else {
          expect(snapshot.session).not.toHaveProperty("slackThread");
          expect(messages[0].session).not.toHaveProperty("slackThread");
        }
      } finally {
        ws.close();
      }
    }
  );

  it("rejects a second subscribe on the same socket", async () => {
    const name = `snapshot-duplicate-subscribe-${Date.now()}`;
    await initNamedSession(name);
    const { ws, token } = await openClientWs(name, { subscribe: true });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener("close", (event) => {
        resolve({ code: event.code, reason: event.reason });
      });
    });

    ws.send(
      JSON.stringify({
        type: "subscribe",
        token,
        clientId: "duplicate-client",
      })
    );

    await expect(closed).resolves.toEqual({ code: 4003, reason: "Already subscribed" });
  });
});
