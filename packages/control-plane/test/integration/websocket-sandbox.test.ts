import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { componentsOf, runInSessionDO } from "./session-do-access";
import { hostContract } from "../conformance/session-core-conformance";
import { encryptToken } from "../../src/auth/crypto";
import {
  collectMessages,
  initNamedSession,
  openClientWs,
  openSandboxWs,
  seedSandboxAuth,
  seedMessage,
  queryDO,
  waitForSandboxStatus,
} from "./helpers";

const SANDBOX_TOKEN = "test-sandbox-auth-token-abc123";
const SANDBOX_ID = "sb-integration-test";

function openSandboxSockets(state: DurableObjectState): WebSocket[] {
  return state.getWebSockets("sandbox").filter((socket) => socket.readyState === WebSocket.OPEN);
}

describe("Sandbox WebSocket (via SELF.fetch)", () => {
  it("upgrade with valid auth returns 101", async () => {
    const name = `ws-sandbox-ok-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(101);
    expect(ws).not.toBeNull();
    ws!.accept();
    ws!.close();
  });

  it("upgrade with wrong token returns 401", async () => {
    const name = `ws-sandbox-badtoken-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: "wrong-token",
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(401);
    expect(ws).toBeNull();
  });

  it("upgrade with wrong sandbox ID returns 403", async () => {
    const name = `ws-sandbox-badid-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: "wrong-sandbox-id",
    });

    expect(response.status).toBe(403);
    expect(ws).toBeNull();
  });

  it.each(["stopped", "stale"] as const)("upgrade for %s sandbox returns 410", async (status) => {
    const name = `ws-sandbox-${status}-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status,
    });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(410);
    expect(ws).toBeNull();
  });

  it.each(["archived", "cancelled"] as const)(
    "upgrade for %s session returns 410",
    async (status) => {
      const name = `ws-session-${status}-${Date.now()}`;
      const { stub } = await initNamedSession(name);
      await seedSandboxAuth(stub, {
        authToken: SANDBOX_TOKEN,
        sandboxId: SANDBOX_ID,
        status: "ready",
      });
      await runInSessionDO(stub, (instance: SessionDO, state) => {
        state.storage.sql.exec("UPDATE session SET status = ?", status);
      });

      const { ws, response } = await openSandboxWs(name, {
        authToken: SANDBOX_TOKEN,
        sandboxId: SANDBOX_ID,
      });

      expect(response.status).toBe(410);
      expect(ws).toBeNull();
    }
  );

  it.each(["completed", "failed"] as const)(
    "upgrade for %s session allows a connecting sandbox",
    async (status) => {
      const name = `ws-session-${status}-${Date.now()}`;
      const { stub } = await initNamedSession(name);
      await seedSandboxAuth(stub, {
        authToken: SANDBOX_TOKEN,
        sandboxId: SANDBOX_ID,
        status: "connecting",
      });
      await runInSessionDO(stub, (instance: SessionDO, state) => {
        state.storage.sql.exec("UPDATE session SET status = ?", status);
      });

      const { ws, response } = await openSandboxWs(name, {
        authToken: SANDBOX_TOKEN,
        sandboxId: SANDBOX_ID,
      });

      expect(response.status).toBe(101);
      expect(ws).not.toBeNull();
      ws!.accept();
      await waitForSandboxStatus(stub, "ready");
      ws!.close();
    }
  );

  /**
   * Queue SQL mutations from the pre-authentication sandbox read so they land
   * inside the token-hash await: the read runs to completion — so anything
   * checked against its returned row sees the pre-mutation state — before the
   * microtask fires, guaranteeing the mutation falls inside the
   * `crypto.subtle.digest` suspension rather than before or after it.
   */
  async function mutateSandboxDuringAuth(
    stub: DurableObjectStub,
    ...statements: string[]
  ): Promise<void> {
    await runInSessionDO(stub, (instance: SessionDO, state) => {
      const repository = componentsOf(instance).sandboxRepository;
      const readSandbox = repository.getSandbox.bind(repository);
      vi.spyOn(repository, "getSandbox").mockImplementation(() => {
        const sandbox = readSandbox();
        queueMicrotask(() => {
          for (const statement of statements) {
            state.storage.sql.exec(statement);
          }
        });
        return sandbox;
      });
    });
  }

  hostContract("host.socket-terminal-upgrade", async () => {
    const name = `ws-session-auth-race-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "ready",
    });

    // Token hashing is a non-storage await, so the Durable Object input gate
    // does not hold other events back while it runs. Cancelling mid-hash is the
    // real race: a status read taken before the await is already stale by the
    // time the upgrade is accepted.
    await mutateSandboxDuringAuth(
      stub,
      "UPDATE session SET status = 'cancelled'",
      "UPDATE sandbox SET status = 'stopped'"
    );

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(410);
    // Pin the branch: after authentication the session guard runs before the
    // sandbox guard, so the fresh session read must be what rejected this.
    expect(await response.text()).toBe("Session is terminal");
    expect(ws).toBeNull();
    // The rejected upgrade must not flip the sandbox back to `ready`.
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "stopped" },
    ]);
  });

  it("revalidates sandbox lifecycle state after asynchronous authentication", async () => {
    const name = `ws-sandbox-stop-race-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "ready",
    });

    // Only the sandbox stops mid-hash; the session stays promptable, so only
    // a fresh post-authentication sandbox read can reject this upgrade.
    await mutateSandboxDuringAuth(stub, "UPDATE sandbox SET status = 'stopped'");

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(410);
    expect(await response.text()).toBe("Sandbox is stopped");
    expect(ws).toBeNull();
    // The rejected upgrade must not flip the sandbox back to `ready`.
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "stopped" },
    ]);
  });

  it("rejects credentials rotated during asynchronous authentication", async () => {
    const name = `ws-sandbox-rotate-race-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "ready",
    });

    // A respawn rotates the auth token mid-hash. The presented token still
    // matches the pre-rotation row captured before the await, so token
    // validation alone would admit a bridge the current row no longer trusts.
    await mutateSandboxDuringAuth(
      stub,
      "UPDATE sandbox SET auth_token_hash = 'rotated-token-hash'"
    );

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden: Sandbox credentials changed");
    expect(ws).toBeNull();
  });

  it("returns 401, not 410, for a stopped sandbox with an invalid token (auth precedes state checks)", async () => {
    const name = `ws-sandbox-stopped-badtoken-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "stopped",
    });

    // Contract change ported from prod: lifecycle state is only revealed to
    // authenticated callers. An unauthenticated caller used to see 410 from
    // the pre-auth stopped-sandbox guard; it now gets 401.
    const { ws, response } = await openSandboxWs(name, {
      authToken: "wrong-token",
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized: Invalid auth token");
    expect(ws).toBeNull();
  });

  hostContract("host.socket-single-sandbox", async () => {
    const name = `ws-sandbox-replacement-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "ready",
    });

    const rejected = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: "stale-sandbox-id",
    });
    expect(rejected.response.status).toBe(403);
    expect(rejected.ws).toBeNull();

    // A bridge that connected before the runtime was rebuilt: after
    // hibernation only its tagged socket survives, accepted at the platform
    // level and unknown to the manager's in-memory pointer. Replacement must
    // find it through the host's sockets, not through that pointer.
    await runInSessionDO(stub, (instance: SessionDO, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[1], ["sandbox", `sid:${SANDBOX_ID}`]);
      pair[0].accept();
      expect(openSandboxSockets(state)).toHaveLength(1);
    });

    const { ws: replacementWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(replacementWs).not.toBeNull();
    replacementWs!.accept();

    await runInSessionDO(stub, (instance: SessionDO, state) => {
      const liveSandboxSockets = openSandboxSockets(state);
      expect(liveSandboxSockets).toHaveLength(1);
      expect(state.getTags(liveSandboxSockets[0])).toContain(`sid:${SANDBOX_ID}`);
    });

    replacementWs!.close();
  });

  it("sandbox connect sets status to ready", async () => {
    const name = `ws-sandbox-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    // Model the production boot sequence: the sandbox connects while the
    // lifecycle is still in "connecting", and the WS accept flips it to ready.
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });

    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    await waitForSandboxStatus(stub, "ready");

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ sandbox: { status: string } }>();
    expect(state.sandbox.status).toBe("ready");

    ws!.close();
  });

  it("publishes sandbox access only after it becomes readable", async () => {
    const name = `ws-sandbox-access-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const [codePassword, vncPassword, terminalToken] = await Promise.all([
      encryptToken("code-secret", env.REPO_SECRETS_ENCRYPTION_KEY!),
      encryptToken("vnc-secret", env.REPO_SECRETS_ENCRYPTION_KEY!),
      encryptToken("terminal-token", env.REPO_SECRETS_ENCRYPTION_KEY!),
    ]);
    await runInSessionDO(stub, (instance: SessionDO, state) => {
      state.storage.sql.exec(
        `UPDATE sandbox
         SET code_server_url = ?, code_server_password = ?, vnc_url = ?, vnc_password = ?,
             ttyd_url = ?, ttyd_token = ?`,
        "https://code.test",
        codePassword,
        "https://vnc.test",
        vncPassword,
        "https://terminal.test",
        terminalToken
      );
    });
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });
    const collector = collectMessages(clientWs, {
      until: (message) => message.type === "sandbox_access_changed",
    });

    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(sandboxWs).not.toBeNull();
    sandboxWs!.accept();

    const messages = await collector;
    expect(messages.slice(-2).map((message) => message.type)).toEqual([
      "sandbox_status",
      "sandbox_access_changed",
    ]);
    const accessResponse = await stub.fetch("http://internal/internal/sandbox-access");
    expect(accessResponse.status).toBe(200);
    await expect(accessResponse.json()).resolves.toEqual({
      codeServer: { url: "https://code.test", password: "code-secret" },
      vnc: { url: "https://vnc.test", password: "vnc-secret" },
      ttyd: { url: "https://terminal.test", token: "terminal-token" },
      tunnelUrls: null,
      sandboxDashboardUrl: null,
    });

    sandboxWs!.close();
    clientWs.close();
  });

  it("does not publish sandbox access for replacement bridges during provider startup", async () => {
    const name = `ws-sandbox-access-spawning-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "spawning",
    });
    await runInSessionDO(stub, (instance: SessionDO) => {
      const lifecycleManager = componentsOf(instance).lifecycleManager as unknown as {
        providerStartupPending: boolean;
      };
      lifecycleManager.providerStartupPending = true;
    });
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });
    const collector = collectMessages(clientWs, { timeoutMs: 100 });

    const { ws: firstSandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(firstSandboxWs).not.toBeNull();
    firstSandboxWs!.accept();

    const { ws: replacementSandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(replacementSandboxWs).not.toBeNull();
    replacementSandboxWs!.accept();

    const messages = await collector;
    expect(
      messages.filter((message) => message.type === "sandbox_status" && message.status === "ready")
    ).toHaveLength(2);
    expect(messages).not.toContainEqual({ type: "sandbox_access_changed" });

    replacementSandboxWs!.close();
    clientWs.close();
  });

  it.each([1000, 1001])(
    "allows the active sandbox to reconnect after close code %s",
    async (closeCode) => {
      const name = `ws-sandbox-reconnect-${closeCode}-${Date.now()}`;
      const { stub } = await initNamedSession(name);
      await seedSandboxAuth(stub, {
        authToken: SANDBOX_TOKEN,
        sandboxId: SANDBOX_ID,
        status: "ready",
      });

      const { ws: firstWs } = await openSandboxWs(name, {
        authToken: SANDBOX_TOKEN,
        sandboxId: SANDBOX_ID,
      });
      expect(firstWs).not.toBeNull();
      firstWs!.accept();

      const closed = new Promise<void>((resolve) => {
        firstWs!.addEventListener("close", () => resolve());
      });
      firstWs!.close(closeCode, closeCode === 1001 ? "Going away" : "Normal closure");
      await closed;

      const stateAfterClose = await stub.fetch("http://internal/internal/state");
      const state = await stateAfterClose.json<{ sandbox: { status: string } }>();
      expect(state.sandbox.status).toBe("ready");

      const { ws: reconnectedWs, response } = await openSandboxWs(name, {
        authToken: SANDBOX_TOKEN,
        sandboxId: SANDBOX_ID,
      });
      expect(response.status).toBe(101);
      expect(reconnectedWs).not.toBeNull();
      reconnectedWs!.accept();
      reconnectedWs!.close();
    }
  );

  it("refreshes heartbeat on reconnect before an old disconnect alarm runs", async () => {
    const name = `ws-sandbox-reconnect-heartbeat-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "ready",
    });

    const { ws: firstWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(firstWs).not.toBeNull();
    firstWs!.accept();

    const closed = new Promise<void>((resolve) => {
      firstWs!.addEventListener("close", () => resolve());
    });
    firstWs!.close(1001, "Going away");
    await closed;

    const oldHeartbeat = Date.now() - 10 * 60 * 1000;
    await runInSessionDO(stub, (instance: SessionDO, state) => {
      state.storage.sql.exec("UPDATE sandbox SET last_heartbeat = ?", oldHeartbeat);
    });

    const { ws: reconnectedWs, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(response.status).toBe(101);
    expect(reconnectedWs).not.toBeNull();
    reconnectedWs!.accept();

    const sandboxAfterReconnect = await queryDO<{ last_heartbeat: number; status: string }>(
      stub,
      "SELECT last_heartbeat, status FROM sandbox"
    );
    expect(sandboxAfterReconnect[0].last_heartbeat).toBeGreaterThan(oldHeartbeat);

    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());

    const sandboxAfterAlarm = await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox");
    expect(sandboxAfterAlarm[0].status).toBe("ready");

    reconnectedWs!.close();
  });

  it("failed sandbox can reconnect and self-heal to ready", async () => {
    const name = `ws-sandbox-selfheal-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    // The WS upgrade gate deliberately admits "failed" sandboxes: a slow boot
    // that outlived the connecting watchdog recovers here, unlike stopped or
    // stale which are rejected with 410.
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "failed",
    });

    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    await waitForSandboxStatus(stub, "ready");
    ws!.close();
  });

  it("sandbox WS message is stored as event", async () => {
    const name = `ws-sandbox-event-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();

    // Send a token event via the sandbox WebSocket
    ws!.send(
      JSON.stringify({
        type: "tool_call",
        tool: "read_file",
        args: { path: "/src/main.ts" },
        callId: "call-ws-1",
        messageId: "msg-ws-1",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
      })
    );

    // Allow time for the DO to process the message
    await new Promise((r) => setTimeout(r, 200));

    const events = await queryDO<{ type: string; data: string }>(
      stub,
      "SELECT type, data FROM events WHERE type = ?",
      "tool_call"
    );

    const matching = events.filter((e) => {
      const data = JSON.parse(e.data);
      return data.callId === "call-ws-1";
    });
    expect(matching.length).toBeGreaterThanOrEqual(1);

    ws!.close();
  });

  hostContract("host.socket-ack-redelivery", async () => {
    const name = `ws-sandbox-ack-redelivery-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "message-ack-redelivery",
      authorId,
      content: "Finish once",
      source: "web",
      status: "processing",
      createdAt: 100,
      startedAt: 200,
    });
    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();

    const event = {
      type: "execution_complete",
      messageId: "message-ack-redelivery",
      success: true,
      sandboxId: SANDBOX_ID,
      timestamp: Date.now() / 1000,
      ackId: "ack-redelivery-1",
    };
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const ack = collectMessages(ws!, {
        until: (message) => message.type === "ack" && message.ackId === event.ackId,
      });
      ws!.send(JSON.stringify(event));
      expect(await ack).toContainEqual({ type: "ack", ackId: event.ackId });
    }

    expect(
      await queryDO<{ status: string; completed_at: number }>(
        stub,
        "SELECT status, completed_at FROM messages WHERE id = ?",
        event.messageId
      )
    ).toMatchObject([{ status: "completed" }]);
    expect(
      await queryDO<{ count: number }>(
        stub,
        "SELECT COUNT(*) AS count FROM events WHERE id = ?",
        `execution_complete:${event.messageId}`
      )
    ).toEqual([{ count: 1 }]);

    ws!.close();
  });

  it("preserves token segments around context compaction for replay", async () => {
    const name = `ws-sandbox-compaction-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(sandboxWs).not.toBeNull();
    sandboxWs!.accept();

    const collector = collectMessages(clientWs, {
      until: (message) => {
        if (message.type !== "sandbox_event") return false;
        const event = message.event as { type?: string; content?: string };
        return event.type === "token" && event.content === "After compaction";
      },
    });
    const before = {
      type: "token",
      content: "Before compaction",
      messageId: "msg-compaction-1",
      sandboxId: SANDBOX_ID,
      timestamp: 1,
    } as const;
    const compacted = {
      type: "context_compacted",
      messageId: "msg-compaction-1",
      sandboxId: SANDBOX_ID,
      timestamp: 2,
    } as const;
    const after = {
      type: "token",
      content: "After compaction",
      messageId: "msg-compaction-1",
      sandboxId: SANDBOX_ID,
      timestamp: 3,
    } as const;
    sandboxWs!.send(JSON.stringify(before));
    sandboxWs!.send(JSON.stringify(compacted));
    sandboxWs!.send(JSON.stringify(after));

    const messages = await collector;
    expect(messages).toContainEqual({ type: "sandbox_event", event: compacted });
    const events = await queryDO<{
      id: string;
      type: string;
      data: string;
      timeline_sequence: number;
    }>(
      stub,
      "SELECT id, type, data, timeline_sequence FROM events WHERE message_id = ? ORDER BY timeline_sequence",
      "msg-compaction-1"
    );
    expect(events.map(({ type, data }) => ({ type, event: JSON.parse(data) }))).toEqual([
      { type: "token", event: before },
      { type: "context_compacted", event: compacted },
      { type: "token", event: after },
    ]);
    expect(events[0].id).toMatch(/^token:msg-compaction-1:/);
    expect(events[2].id).toBe("token:msg-compaction-1");

    const { ws: replayWs, messages: replayMessages } = await openClientWs(name, {
      subscribe: true,
      userId: "user-replay",
    });
    const subscribed = replayMessages.find((message) => message.type === "subscribed") as
      | { timeline: { events: Array<{ event: unknown }> } }
      | undefined;
    expect(subscribed?.timeline.events.map(({ event }) => event)).toEqual([
      before,
      compacted,
      after,
    ]);

    sandboxWs!.close();
    clientWs.close();
    replayWs.close();
  });

  it("accepts step_finish messages with structured token usage", async () => {
    const name = `ws-sandbox-step-finish-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(sandboxWs).not.toBeNull();
    sandboxWs!.accept();

    const tokenUsage = {
      total: 223,
      input: 219,
      output: 4,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    const collector = collectMessages(clientWs, {
      until: (msg) =>
        msg.type === "sandbox_event" &&
        (msg.event as Record<string, unknown> | undefined)?.type === "step_finish",
    });

    sandboxWs!.send(
      JSON.stringify({
        type: "step_finish",
        messageId: "msg-step-finish-1",
        cost: 0.001,
        tokens: tokenUsage,
        reason: "end_turn",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now(),
      })
    );

    const messages = await collector;
    const stepFinish = messages.find(
      (msg) =>
        msg.type === "sandbox_event" &&
        (msg.event as Record<string, unknown> | undefined)?.type === "step_finish"
    );

    expect(stepFinish).toBeDefined();
    expect((stepFinish!.event as { tokens: unknown }).tokens).toEqual(tokenUsage);

    sandboxWs!.close();
    clientWs.close();
  });
});
