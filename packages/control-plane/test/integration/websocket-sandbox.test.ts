import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { encryptToken } from "../../src/auth/crypto";
import {
  collectMessages,
  initNamedSession,
  openClientWs,
  openSandboxWs,
  seedSandboxAuth,
  queryDO,
  waitForSandboxStatus,
} from "./helpers";

const SANDBOX_TOKEN = "test-sandbox-auth-token-abc123";
const SANDBOX_ID = "sb-integration-test";

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

  it("upgrade for stopped sandbox returns 410", async () => {
    const name = `ws-sandbox-stopped-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "stopped",
    });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(410);
    expect(ws).toBeNull();
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
      encryptToken("code-secret", env.REPO_SECRETS_ENCRYPTION_KEY),
      encryptToken("vnc-secret", env.REPO_SECRETS_ENCRYPTION_KEY),
      encryptToken("terminal-token", env.REPO_SECRETS_ENCRYPTION_KEY),
    ]);
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
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
    await runInDurableObject(stub, (instance: SessionDO) => {
      const lifecycleManager = (
        instance as unknown as {
          lifecycleManager: { providerStartupPending: boolean };
        }
      ).lifecycleManager;
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
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec("UPDATE sandbox SET last_heartbeat = ?", oldHeartbeat);
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

    await runInDurableObject(stub, (instance: SessionDO) => instance.alarm());

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
      until: (message) =>
        message.type === "sandbox_event" &&
        message.event.type === "token" &&
        message.event.content === "After compaction",
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
