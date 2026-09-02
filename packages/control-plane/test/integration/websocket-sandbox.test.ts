import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { componentsOf, runInSessionDO } from "./session-do-access";
import { encryptToken } from "../../src/auth/crypto";
import type { Logger } from "../../src/logger";
import { SessionWebSocketManagerImpl } from "../../src/session/websocket-manager";
import { WsClientMappingRepository } from "../../src/session/ws-client-mapping-repository";
import { DEFAULT_HEARTBEAT_CONFIG } from "../../src/sandbox/lifecycle/decisions";
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

function announceReady(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: "ready",
      sandboxId: SANDBOX_ID,
      timestamp: Date.now() / 1000,
    })
  );
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

  it("rejects reconnects while snapshotting and requires ready after completion", async () => {
    const name = `ws-sandbox-snapshot-reconnect-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "snapshotting",
    });

    const rejected = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(rejected.response.status).toBe(503);
    expect(rejected.ws).toBeNull();
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "snapshotting" },
    ]);

    await runInSessionDO(stub, (instance: SessionDO) => {
      componentsOf(instance).lifecycleManager.spawnSandbox = vi.fn(async () => {});
    });
    const promptResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "wait for snapshot reconnect",
        authorId: "user-1",
        source: "web",
      }),
    });
    const { messageId } = await promptResponse.json<{ messageId: string }>();
    expect(
      await queryDO<{ status: string }>(stub, "SELECT status FROM messages WHERE id = ?", messageId)
    ).toEqual([{ status: "pending" }]);
    expect(
      await runInSessionDO(
        stub,
        (instance: SessionDO) =>
          vi.mocked(componentsOf(instance).lifecycleManager.spawnSandbox).mock.calls.length
      )
    ).toBe(0);

    await runInSessionDO(stub, async (instance: SessionDO, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox SET status = 'ready', modal_object_id = 'snapshot-object'"
      );
      const components = componentsOf(instance);
      await components.lifecycleManager.triggerSnapshot("integration_test", () =>
        components.messageQueue.processMessageQueue()
      );
    });
    expect(
      await runInSessionDO(
        stub,
        (instance: SessionDO) =>
          vi.mocked(componentsOf(instance).lifecycleManager.spawnSandbox).mock.calls.length
      )
    ).toBe(0);
    const admitted = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(admitted.response.status).toBe(101);
    admitted.ws!.accept();
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "connecting" },
    ]);

    const prompt = collectMessages(admitted.ws!, {
      until: (message) => message.type === "prompt",
    });
    announceReady(admitted.ws!);
    expect(await prompt).toContainEqual(expect.objectContaining({ type: "prompt", messageId }));
    await waitForSandboxStatus(stub, "ready");
    admitted.ws!.close();
  });

  it("drains snapshot completion when the existing control socket remains connected", async () => {
    const name = `ws-sandbox-connected-snapshot-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "ready",
    });
    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    ws!.accept();
    announceReady(ws!);
    await waitForSandboxStatus(stub, "ready");
    await runInSessionDO(stub, (_instance: SessionDO, state) => {
      state.storage.sql.exec("UPDATE sandbox SET modal_object_id = 'snapshot-object'");
    });

    const processCalls = await runInSessionDO(stub, async (instance: SessionDO) => {
      const processMessageQueue = vi.fn(async () => {});
      await componentsOf(instance).lifecycleManager.triggerSnapshot(
        "integration_test",
        processMessageQueue
      );
      return processMessageQueue.mock.calls.length;
    });

    expect(processCalls).toBe(1);
    ws!.close();
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
      announceReady(ws!);
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

  it("revalidates terminal state after asynchronous authentication", async () => {
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

  it("ready initializes persisted liveness, activity, and the heartbeat deadline", async () => {
    const name = `ws-sandbox-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
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

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ sandbox: { status: string } }>();
    expect(state.sandbox.status).toBe("connecting");
    await runInSessionDO(stub, (instance: SessionDO, durableState) =>
      durableState.storage.deleteAlarm()
    );

    const readyAt = Date.now();
    announceReady(ws!);
    await waitForSandboxStatus(stub, "ready");
    const [sandbox] = await queryDO<{ last_heartbeat: number; last_activity: number }>(
      stub,
      "SELECT last_heartbeat, last_activity FROM sandbox"
    );
    expect(sandbox.last_heartbeat).toBeGreaterThanOrEqual(readyAt);
    expect(sandbox.last_activity).toBeGreaterThanOrEqual(readyAt);
    const alarm = await runInSessionDO(stub, (instance: SessionDO, durableState) =>
      durableState.storage.getAlarm()
    );
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(readyAt);
    expect(alarm!).toBeLessThan(readyAt + 5 * 60 * 1000);

    ws!.close();
  });

  it("keeps an early prompt pending and dispatches it only after ready", async () => {
    const name = `ws-sandbox-early-prompt-${Date.now()}`;
    const { stub } = await initNamedSession(name);
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

    const response = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "wait for ready", authorId: "user-1", source: "web" }),
    });
    const { messageId } = await response.json<{ messageId: string }>();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      await queryDO<{ status: string }>(stub, "SELECT status FROM messages WHERE id = ?", messageId)
    ).toEqual([{ status: "pending" }]);

    const prompt = collectMessages(ws!, {
      until: (message) => message.type === "prompt",
    });
    announceReady(ws!);

    expect((await prompt).find((message) => message.type === "prompt")).toEqual(
      expect.objectContaining({ type: "prompt", messageId })
    );
    expect(
      await queryDO<{ status: string }>(stub, "SELECT status FROM messages WHERE id = ?", messageId)
    ).toEqual([{ status: "processing" }]);
    ws!.close();
  });

  it("does not accept ready from a replaced sender", async () => {
    const name = `ws-sandbox-stale-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const { ws: firstWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(firstWs).not.toBeNull();
    firstWs!.accept();
    const firstServer = await runInSessionDO(
      stub,
      (instance: SessionDO, state) => state.getWebSockets("sandbox")[0]
    );

    const { ws: replacementWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(replacementWs).not.toBeNull();
    replacementWs!.accept();
    await runInSessionDO(stub, (instance: SessionDO) =>
      instance.webSocketMessage(
        firstServer,
        JSON.stringify({
          type: "ready",
          sandboxId: SANDBOX_ID,
          timestamp: Date.now() / 1000,
        })
      )
    );
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "connecting" },
    ]);

    announceReady(replacementWs!);
    await waitForSandboxStatus(stub, "ready");
    replacementWs!.close();
  });

  it("closes a hibernated sandbox socket when replacement is admitted after eviction", async () => {
    const name = `ws-sandbox-evicted-replacement-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const { ws: firstWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(firstWs).not.toBeNull();
    firstWs!.accept();
    const firstClosed = new Promise<void>((resolve) => {
      firstWs!.addEventListener("close", () => resolve(), { once: true });
    });

    await runInSessionDO(stub, async (instance: SessionDO, state) => {
      const pair = new WebSocketPair();
      // A fresh manager models a rehydrated DO whose socket cache is empty.
      const manager = new SessionWebSocketManagerImpl(
        state,
        componentsOf(instance).sandboxRepository,
        new WsClientMappingRepository(state.storage.sql),
        { debug() {}, info() {}, warn() {}, error() {}, child() {} } as unknown as Logger,
        { authTimeoutMs: 1000 }
      );
      manager.acceptAndSetSandboxSocket(pair[1], SANDBOX_ID);
      pair[0].accept();
      await instance.webSocketMessage(
        pair[1],
        JSON.stringify({
          type: "ready",
          sandboxId: SANDBOX_ID,
          timestamp: Date.now() / 1000,
        })
      );
      pair[0].close();
    });

    await expect(firstClosed).resolves.toBeUndefined();
    await waitForSandboxStatus(stub, "ready");
  });

  it("keeps reconnect execution gated until ready is reannounced", async () => {
    const name = `ws-sandbox-reconnect-gating-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const { ws: firstWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(firstWs).not.toBeNull();
    firstWs!.accept();
    announceReady(firstWs!);
    await waitForSandboxStatus(stub, "ready");
    firstWs!.close(1001, "reconnect");

    const { ws: replacementWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(replacementWs).not.toBeNull();
    replacementWs!.accept();
    const response = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "after reconnect", authorId: "user-1", source: "web" }),
    });
    const { messageId } = await response.json<{ messageId: string }>();
    expect(
      await queryDO<{ status: string }>(stub, "SELECT status FROM messages WHERE id = ?", messageId)
    ).toEqual([{ status: "pending" }]);

    const prompt = collectMessages(replacementWs!, {
      until: (message) => message.type === "prompt",
    });
    announceReady(replacementWs!);
    expect(await prompt).toContainEqual(expect.objectContaining({ type: "prompt", messageId }));
    replacementWs!.close();
  });

  it("keeps a control-only prompt pending before provider-auth validation", async () => {
    const name = `ws-sandbox-auth-order-${Date.now()}`;
    const { stub } = await initNamedSession(name);
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

    const response = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "wait before auth",
        authorId: "user-1",
        source: "web",
        model: "xai/grok-4.5",
      }),
    });
    const { messageId } = await response.json<{ messageId: string }>();

    expect(
      await queryDO<{ status: string; error_message: string | null }>(
        stub,
        "SELECT status, error_message FROM messages WHERE id = ?",
        messageId
      )
    ).toEqual([{ status: "pending", error_message: null }]);
    ws!.close();
  });

  it("preserves senderless authenticated HTTP heartbeat ingestion", async () => {
    const name = `ws-sandbox-http-heartbeat-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const oldHeartbeat = Date.now() - 60_000;
    await runInSessionDO(stub, (instance: SessionDO, state) => {
      state.storage.sql.exec("UPDATE sandbox SET last_heartbeat = ?", oldHeartbeat);
    });

    const response = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "heartbeat",
        sandboxId: SANDBOX_ID,
        status: "booting",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(response.status).toBe(200);
    expect(
      await queryDO<{ last_heartbeat: number }>(stub, "SELECT last_heartbeat FROM sandbox")
    ).toEqual([{ last_heartbeat: expect.any(Number) }]);
    const [sandbox] = await queryDO<{ last_heartbeat: number }>(
      stub,
      "SELECT last_heartbeat FROM sandbox"
    );
    expect(sandbox.last_heartbeat).toBeGreaterThan(oldHeartbeat);
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
    announceReady(sandboxWs!);

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

    const { ws: firstSandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(firstSandboxWs).not.toBeNull();
    firstSandboxWs!.accept();
    const firstReady = collectMessages(clientWs, {
      until: (message) => message.type === "sandbox_status" && message.status === "ready",
    });
    announceReady(firstSandboxWs!);
    const firstMessages = await firstReady;
    expect(firstMessages).toContainEqual({ type: "sandbox_status", status: "ready" });

    const { ws: replacementSandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(replacementSandboxWs).not.toBeNull();
    replacementSandboxWs!.accept();
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "connecting" },
    ]);
    const replacementReady = collectMessages(clientWs, {
      until: (message) => message.type === "sandbox_status" && message.status === "ready",
    });
    announceReady(replacementSandboxWs!);

    const replacementMessages = await replacementReady;
    expect(replacementMessages).toContainEqual({ type: "sandbox_status", status: "ready" });
    const messages = [...firstMessages, ...replacementMessages];
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
      announceReady(firstWs!);
      await waitForSandboxStatus(stub, "ready");

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
    announceReady(firstWs!);
    await waitForSandboxStatus(stub, "ready");

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
    expect(sandboxAfterAlarm[0].status).toBe("connecting");
    announceReady(reconnectedWs!);
    await waitForSandboxStatus(stub, "ready");

    reconnectedWs!.close();
  });

  it("renews the heartbeat lease when a heartbeat arrives before alarm delivery", async () => {
    const name = `ws-sandbox-renewable-heartbeat-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "ready",
    });
    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    ws!.accept();
    announceReady(ws!);
    await waitForSandboxStatus(stub, "ready");

    const beforeHeartbeat = Date.now();
    ws!.send(
      JSON.stringify({
        type: "heartbeat",
        sandboxId: SANDBOX_ID,
        status: "running",
        timestamp: beforeHeartbeat / 1000,
      })
    );
    await vi.waitFor(async () => {
      const [sandbox] = await queryDO<{ last_heartbeat: number }>(
        stub,
        "SELECT last_heartbeat FROM sandbox"
      );
      expect(sandbox.last_heartbeat).toBeGreaterThanOrEqual(beforeHeartbeat);
    });
    const [renewed] = await queryDO<{ last_heartbeat: number }>(
      stub,
      "SELECT last_heartbeat FROM sandbox"
    );

    await runInSessionDO(stub, async (instance: SessionDO, state) => {
      await state.storage.deleteAlarm();
      await instance.alarm();
    });
    const nextAlarm = await runInSessionDO(stub, (_instance: SessionDO, state) =>
      state.storage.getAlarm()
    );
    expect(nextAlarm).toBe(renewed.last_heartbeat + DEFAULT_HEARTBEAT_CONFIG.timeoutMs);

    await runInSessionDO(stub, (_instance: SessionDO, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox SET last_heartbeat = ?",
        Date.now() - DEFAULT_HEARTBEAT_CONFIG.timeoutMs - 1
      );
    });
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());
    await waitForSandboxStatus(stub, "stale");
    ws!.close();
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
    announceReady(ws!);
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
