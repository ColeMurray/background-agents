import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { componentsOf, runInSessionDO } from "./session-do-access";
import { encryptToken } from "../../src/auth/crypto";
import {
  collectMessages,
  initNamedSession,
  openClientWs,
  openRuntimeControlWs,
  openSandboxWs,
  seedSandboxAuth,
  seedMessage,
  queryDO,
  waitForSandboxStatus,
} from "./helpers";

const SANDBOX_TOKEN = "test-sandbox-auth-token-abc123";
const SANDBOX_ID = "sb-integration-test";

describe("Sandbox WebSocket (via SELF.fetch)", () => {
  it("decodes an encoded session ID on the dedicated runtime path", async () => {
    const name = `ws/runtime-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });

    const { ws, response } = await openRuntimeControlWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(101);
    ws!.accept();
    ws!.close();
  });

  it("admits the dedicated runtime-control path without making it execution-ready", async () => {
    const name = `ws-runtime-control-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });

    const { ws, response } = await openRuntimeControlWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(101);
    expect(ws).not.toBeNull();
    ws!.accept();
    await waitForSandboxStatus(stub, "booting");
    expect(
      await queryDO<{
        status: string;
        runtime_protocol_version: number;
        last_heartbeat: number;
        last_activity: number | null;
      }>(
        stub,
        "SELECT status, runtime_protocol_version, last_heartbeat, last_activity FROM sandbox"
      )
    ).toEqual([
      {
        status: "booting",
        runtime_protocol_version: 2,
        last_heartbeat: expect.any(Number),
        last_activity: null,
      },
    ]);
    ws!.close();
  });

  it("keeps a pending prompt blocked through attach and dispatches after connection-scoped ready", async () => {
    const name = `ws-runtime-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "pending-through-boot",
      authorId: participants[0].id,
      content: "wait for runtime readiness",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    const { ws } = await openRuntimeControlWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    await waitForSandboxStatus(stub, "booting");
    expect(
      await queryDO<{ status: string }>(
        stub,
        "SELECT status FROM messages WHERE id = ?",
        "pending-through-boot"
      )
    ).toEqual([{ status: "pending" }]);

    const prompt = collectMessages(ws!, { until: (message) => message.type === "prompt" });
    ws!.send(
      JSON.stringify({
        type: "ready",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
        runtimeVersion: "test-runtime",
      })
    );

    expect((await prompt).at(-1)).toMatchObject({
      type: "prompt",
      messageId: "pending-through-boot",
    });
    await waitForSandboxStatus(stub, "ready");
    ws!.close();
  });

  it("persists boot diagnostics and ACKs a fenced boot failure", async () => {
    const name = `ws-runtime-boot-failed-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const { ws } = await openRuntimeControlWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    await waitForSandboxStatus(stub, "booting");
    ws!.send(
      JSON.stringify({
        type: "boot_phase",
        sandboxId: SANDBOX_ID,
        timestamp: 1,
        phase: "opencode_health",
      })
    );
    const ack = collectMessages(ws!, { until: (message) => message.type === "ack" });
    ws!.send(
      JSON.stringify({
        type: "boot_failed",
        sandboxId: SANDBOX_ID,
        timestamp: 2,
        ackId: "boot-failed-1",
        phase: "opencode_health",
        code: "opencode_health_timeout",
      })
    );

    expect((await ack).at(-1)).toEqual({ type: "ack", ackId: "boot-failed-1" });
    await waitForSandboxStatus(stub, "failed");
    expect(
      await queryDO<{ status: string; boot_phase: string; last_spawn_error: string }>(
        stub,
        "SELECT status, boot_phase, last_spawn_error FROM sandbox"
      )
    ).toEqual([
      {
        status: "failed",
        boot_phase: "opencode_health",
        last_spawn_error: "opencode_health_timeout",
      },
    ]);

    const duplicateAck = collectMessages(ws!, { until: (message) => message.type === "ack" });
    ws!.send(
      JSON.stringify({
        type: "boot_failed",
        sandboxId: SANDBOX_ID,
        timestamp: 3,
        ackId: "boot-failed-duplicate",
        phase: "opencode_health",
        code: "opencode_health_timeout",
      })
    );
    expect((await duplicateAck).at(-1)).toEqual({
      type: "ack",
      ackId: "boot-failed-duplicate",
    });
    ws!.close();
  });

  it("starts a replacement v2 socket unconfirmed until it re-announces ready", async () => {
    const name = `ws-runtime-reconnect-unconfirmed-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const first = await openRuntimeControlWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    first.ws!.accept();
    first.ws!.send(JSON.stringify({ type: "ready", sandboxId: SANDBOX_ID, timestamp: 1 }));
    await waitForSandboxStatus(stub, "ready");

    const replacement = await openRuntimeControlWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    replacement.ws!.accept();
    await waitForSandboxStatus(stub, "booting");

    replacement.ws!.send(JSON.stringify({ type: "ready", sandboxId: SANDBOX_ID, timestamp: 2 }));
    await waitForSandboxStatus(stub, "ready");
    replacement.ws!.close();
  });

  it("ACKs boot failure from a superseded identity without failing the replacement", async () => {
    const name = `ws-runtime-boot-fence-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const { ws } = await openRuntimeControlWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    ws!.accept();
    await waitForSandboxStatus(stub, "booting");
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sandbox SET modal_sandbox_id = ?", "replacement-sandbox");
    });
    const ack = collectMessages(ws!, { until: (message) => message.type === "ack" });

    ws!.send(
      JSON.stringify({
        type: "boot_failed",
        sandboxId: SANDBOX_ID,
        timestamp: 1,
        ackId: "superseded-boot-failure",
        phase: "repository_sync",
        code: "repository_boot_failed",
      })
    );

    expect((await ack).at(-1)).toEqual({
      type: "ack",
      ackId: "superseded-boot-failure",
    });
    expect(
      await queryDO<{ modal_sandbox_id: string; status: string }>(
        stub,
        "SELECT modal_sandbox_id, status FROM sandbox"
      )
    ).toEqual([{ modal_sandbox_id: "replacement-sandbox", status: "booting" }]);
    ws!.close();
  });

  it("keeps a long-elapsed boot alive while control heartbeats remain fresh", async () => {
    const name = `ws-runtime-long-boot-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const { ws } = await openRuntimeControlWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    ws!.accept();
    await waitForSandboxStatus(stub, "booting");
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sandbox SET created_at = ?", Date.now() - 24 * 60 * 60 * 1000);
      state.storage.setAlarm(Date.now());
    });
    ws!.send(
      JSON.stringify({
        type: "heartbeat",
        sandboxId: SANDBOX_ID,
        timestamp: 1,
        status: "booting",
        phase: "repository_sync",
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "booting" },
    ]);
    ws!.close();
  });

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
