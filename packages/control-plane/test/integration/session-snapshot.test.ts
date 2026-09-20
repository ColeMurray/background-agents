import { env } from "cloudflare:test";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "../../src/auth/crypto";
import { cleanD1Tables } from "./cleanup";
import { componentsOf, runInSessionDO } from "./session-do-access";
import {
  initNamedSession,
  collectMessages,
  openClientWs,
  openSandboxWs,
  queryDO,
  seedEvents,
  seedSandboxAuth,
  waitForSandboxStatus,
} from "./helpers";

describe("session snapshot synchronization", () => {
  beforeEach(cleanD1Tables);
  afterEach(() => vi.unstubAllGlobals());

  it("retries a Docker snapshot with fresh authority and clears recovery only on current runtime readiness", async () => {
    const name = `vm-retry-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: "old-vm-token",
      sandboxId: "old-vm-generation",
      status: "failed",
    });
    const execution = { profile: "docker-v1", provider: "modal", cpuCores: 2, memoryMib: 4096 };
    await queryDO(stub, "UPDATE session SET sandbox_execution = ?", JSON.stringify(execution));
    await queryDO(
      stub,
      "UPDATE sandbox SET snapshot_image_id = 'im-retained', snapshot_runtime_version = 'v72-test', snapshot_execution_profile = 'docker-v1', snapshot_recovery_error_code = 'artifact_missing', fenced = 1, auth_token_hash = '', auth_token = '', active_socket_id = NULL"
    );
    const originalFetch = globalThis.fetch;
    let restoreRequest: { sandbox_id: string; sandbox_auth_token: string } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes("api-restore-sandbox-v2")) return originalFetch(input, init);
        const body = JSON.parse(String(init?.body));
        expect(body.snapshot_image_id).toBe("im-retained");
        expect(body.sandbox_execution).toEqual(execution);
        restoreRequest = body;
        return Response.json({
          success: true,
          data: {
            sandbox_id: body.sandbox_id,
            modal_object_id: "sb-Restored123",
            execution_profile: "docker-v1",
          },
        });
      })
    );
    const retry = await stub.fetch("http://internal/internal/retry-snapshot", {
      method: "POST",
      body: "{}",
    });
    expect(retry.status).toBe(202);
    await vi.waitFor(() => expect(restoreRequest).toBeDefined());
    const repeated = await stub.fetch("http://internal/internal/retry-snapshot", {
      method: "POST",
      body: "{}",
    });
    expect(repeated.status).toBe(409);
    const prompt = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Continue recovered work",
        authorId: "user-1",
        source: "web",
      }),
    });
    expect(prompt.status).toBe(200);
    const { messageId } = await prompt.json<{ messageId: string }>();
    expect(
      await queryDO<{ status: string }>(stub, "SELECT status FROM messages WHERE id = ?", messageId)
    ).toEqual([{ status: "pending" }]);
    expect(
      (await (await stub.fetch("http://internal/internal/snapshot")).json<SessionSnapshot>())
        .snapshotRecoveryError
    ).toBe("artifact_missing");
    const stale = await openSandboxWs(name, {
      authToken: "old-vm-token",
      sandboxId: "old-vm-generation",
    });
    expect(stale.response.status).toBe(403);
    const { ws } = await openSandboxWs(name, {
      authToken: restoreRequest!.sandbox_auth_token,
      sandboxId: restoreRequest!.sandbox_id,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    try {
      const deliveries = collectMessages(ws!, { timeoutMs: 500 });
      const ready = JSON.stringify({
        type: "ready",
        sandboxId: restoreRequest!.sandbox_id,
        timestamp: Date.now() / 1000,
      });
      ws!.send(ready);
      await waitForSandboxStatus(stub, "ready");
      const snapshot = await (
        await stub.fetch("http://internal/internal/snapshot")
      ).json<SessionSnapshot>();
      expect(snapshot.snapshotRecoveryError).toBeNull();
      expect(snapshot.session.sandboxExecution).toEqual(execution);
      ws!.send(ready);
      expect((await deliveries).filter((message) => message.type === "prompt")).toHaveLength(1);
    } finally {
      ws!.close();
    }
  });

  it("persists incompatible VM snapshot recovery through the real lifecycle and snapshot reader", async () => {
    const { stub } = await initNamedSession(`vm-recovery-${Date.now()}`);
    await waitForSandboxStatus(stub, "failed");
    const execution = { profile: "docker-v1", provider: "modal", cpuCores: 2, memoryMib: 4096 };
    await queryDO(stub, "UPDATE session SET sandbox_execution = ?", JSON.stringify(execution));
    await queryDO(
      stub,
      "UPDATE sandbox SET status = 'stopped', snapshot_image_id = 'im-preserved', snapshot_runtime_version = 'v71-test', snapshot_execution_profile = 'default'"
    );
    await runInSessionDO(stub, (instance) =>
      componentsOf(instance).lifecycleManager.spawnSandbox()
    );
    const first = await (
      await stub.fetch("http://internal/internal/snapshot")
    ).json<SessionSnapshot>();
    expect(first.snapshotRecoveryError).toBe("profile_mismatch");
    expect(first.session.sandboxExecution).toEqual(execution);
    const rows = await queryDO<{ snapshot_image_id: string; fenced: number }>(
      stub,
      "SELECT snapshot_image_id, fenced FROM sandbox"
    );
    expect(rows).toEqual([{ snapshot_image_id: "im-preserved", fenced: 1 }]);
    const rejected = await stub.fetch("http://internal/internal/retry-snapshot", {
      method: "POST",
      body: JSON.stringify({ snapshotImageId: "im-other" }),
    });
    expect(rejected.status).toBe(400);
    const retry = await stub.fetch("http://internal/internal/retry-snapshot", {
      method: "POST",
      body: "{}",
    });
    expect(retry.status).toBe(409);
    const second = await (
      await stub.fetch("http://internal/internal/snapshot")
    ).json<SessionSnapshot>();
    expect(second.snapshotRecoveryError).toBe("profile_mismatch");
  });

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
