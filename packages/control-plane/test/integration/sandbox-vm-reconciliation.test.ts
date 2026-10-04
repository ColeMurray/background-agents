import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { hashToken } from "../../src/auth/crypto";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { createCloudflareEnv, type WorkerBindings } from "../../src/cloudflare/platform";
import { createDurableObjectSessionPlatform } from "../../src/cloudflare/session-platform";
import type { BackgroundTasks, SessionWebSocket } from "../../src/platform-ports";
import { ModalVmStartupError } from "../../src/sandbox/client";
import type { ResolveSandboxResult } from "../../src/sandbox/provider";
import { ModalSandboxProvider } from "../../src/sandbox/providers/modal-provider";
import { formatPendingVmReference } from "../../src/sandbox/providers/pending-vm-reference";
import { createSessionRuntime } from "../../src/session/components";
import { SandboxShutdownRepository } from "../../src/session/sandbox-shutdown-repository";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO, seedSandboxAuth } from "./helpers";
import { runInSessionDO } from "./session-do-access";

const SANDBOX_TIMEOUT_MS = 3_600_000;
const FINAL_SNAPSHOT_BUFFER_MS = 600_000;

beforeEach(cleanD1Tables);
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanD1Tables();
});

async function pendingVmSession() {
  const { stub } = await initNamedSession(`vm-reconciliation-${crypto.randomUUID()}`, {
    sandboxSettings: {
      sandboxTimeoutMs: SANDBOX_TIMEOUT_MS,
      finalSnapshotBufferMs: FINAL_SNAPSHOT_BUFFER_MS,
      terminalEnabled: true,
    },
  });
  await seedSandboxAuth(stub, {
    authToken: "predecessor-token",
    sandboxId: "predecessor-sandbox",
    status: "pending",
  });
  await queryDO(stub, "UPDATE sandbox SET created_at = 0");
  return stub;
}

/** Leave a real foreground create pending, then rebuild the graph over its persisted reservation. */
async function reconstructedPendingVm(instance: SessionDO, state: DurableObjectState) {
  const platform = createDurableObjectSessionPlatform(state, env.DB);
  const tasks: Array<{
    factory: Parameters<BackgroundTasks["submit"]>[0];
    name: string;
    promise: Promise<unknown>;
  }> = [];
  platform.createBackgroundTasks = () => ({
    submit: (factory, metadata) => {
      tasks.push({ factory, name: metadata.name, promise: factory() });
    },
  });

  const adopted = new Map<SessionWebSocket, string[]>();
  vi.spyOn(platform.sockets, "adopt").mockImplementation((socket, tags) => {
    adopted.set(socket, tags);
  });
  vi.spyOn(platform.sockets, "tags").mockImplementation((socket) => adopted.get(socket) ?? []);
  vi.spyOn(platform.sockets, "sockets").mockImplementation((tag) =>
    [...adopted].filter(([, tags]) => !tag || tags.includes(tag)).map(([socket]) => socket)
  );
  const browser = { readyState: 1, send: vi.fn(), close: vi.fn() } satisfies SessionWebSocket;
  const bridge = { readyState: 1, send: vi.fn(), close: vi.fn() } satisfies SessionWebSocket;

  let finishCreate!: () => void;
  const createGate = new Promise<void>((resolve) => (finishCreate = resolve));
  const create = vi
    .spyOn(ModalSandboxProvider.prototype, "createSandbox")
    .mockImplementation(async () => {
      await createGate;
      throw new ModalVmStartupError("unknown", new Error("Original create response was lost"));
    });
  let finishLookup!: (result: ResolveSandboxResult) => void;
  const lookup = new Promise<ResolveSandboxResult>((resolve) => (finishLookup = resolve));
  const resolve = vi
    .spyOn(ModalSandboxProvider.prototype, "resolveSandbox")
    .mockReturnValue(lookup);
  const stop = vi.spyOn(ModalSandboxProvider.prototype, "stopSandbox").mockResolvedValue({
    success: true,
  });

  const runtimeEnv = createCloudflareEnv((instance as unknown as { env: WorkerBindings }).env);
  runtimeEnv.SANDBOX_PROVIDER = "modal-vm";
  const initial = createSessionRuntime(platform, runtimeEnv);
  const spawning = initial.internals.lifecycleManager.spawnSandbox();
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  const config = create.mock.calls[0][0];
  const row = initial.internals.sandboxRepository.getSandbox()!;
  const generation = { sandboxId: row.modal_sandbox_id!, createdAt: row.created_at };
  const reference = formatPendingVmReference(config.sessionId, generation.sandboxId);
  expect(row).toMatchObject({ status: "spawning", modal_object_id: reference, auth_token: null });

  const restarted = createSessionRuntime(platform, runtimeEnv);
  const { wsManager } = restarted.internals;
  wsManager.acceptClientSocket(browser, "observing-browser");
  wsManager.setClient(browser, {
    participantId: "observing-participant",
    userId: "user-1",
    name: "Observer",
    status: "active",
    lastSeen: Date.now(),
    clientId: "observing-browser",
    authorizationExpiresAt: Date.now() + SANDBOX_TIMEOUT_MS,
  });
  wsManager.acceptAndSetSandboxSocket(bridge, generation.sandboxId);

  const result: ResolveSandboxResult = {
    sandboxId: generation.sandboxId,
    providerObjectId: "resolved-vm",
    // A lookup must not replace the reservation's conservative lifetime with this later one.
    lifetime: {
      kind: "finite",
      expiresAtMs: generation.createdAt + SANDBOX_TIMEOUT_MS * 2,
      observedAtMs: Date.now(),
      source: "provider",
    },
    codeServerUrl: "https://editor.test",
    codeServerPassword: "editor-secret",
    vncAccess: { url: "https://desktop.test", password: "desktop-secret" },
    ttydUrl: "https://terminal.test",
    tunnelUrls: { "8080": "https://port.test" },
  };
  return {
    platform,
    runtimeEnv,
    initial,
    restarted,
    browser,
    bridge,
    create,
    resolve,
    stop,
    config,
    generation,
    reference,
    result,
    finishLookup,
    shutdown: new SandboxShutdownRepository(state.storage.sql),
    vmResolution() {
      const resolutions = tasks.filter((task) => task.name === "sandbox.vm_resolve");
      expect(resolutions).toHaveLength(1);
      return resolutions[0];
    },
    async finish() {
      finishLookup(result);
      finishCreate();
      await spawning;
      for (const task of tasks) await task.promise;
    },
  };
}

async function refuseEncryptedLookup(change: "reference" | "timestamp") {
  const stub = await pendingVmSession();
  await runInSessionDO(stub, async (instance, state) => {
    const f = await reconstructedPendingVm(instance, state);
    const { lifecycleManager: manager, sandboxRepository: sandbox } = f.restarted.internals;
    const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let releaseEncryption!: () => void;
    const encryptionGate = new Promise<void>((resolve) => (releaseEncryption = resolve));
    let encryptedBothSecrets!: () => void;
    const encrypted = new Promise<void>((resolve) => (encryptedBothSecrets = resolve));
    let encryptionCount = 0;
    const encrypt = vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      const ciphertext = await realEncrypt(...args);
      if (++encryptionCount === 2) encryptedBothSecrets();
      await encryptionGate;
      return ciphertext;
    });
    try {
      manager.onSandboxConnected();
      manager.onSandboxSocketAttached(f.generation);
      expect(manager.onRuntimeReady(Date.now(), "opencode", 1)).toBe(true);
      const resolution = f.vmResolution();
      f.finishLookup(f.result);
      await encrypted;
      expect(encrypt).toHaveBeenCalledTimes(2);
      expect(sandbox.getSandbox()).toMatchObject({
        status: "ready",
        modal_object_id: f.reference,
        code_server_password: null,
        vnc_password: null,
      });

      // Change each SQL predicate independently while real ciphertext is waiting to return.
      // A different pending reference is not a bridge-resolved handle the foreground may reconcile.
      if (change === "reference")
        sandbox.updateSandboxModalObjectId(
          formatPendingVmReference("other-session", f.generation.sandboxId)
        );
      else state.storage.sql.exec("UPDATE sandbox SET created_at = created_at + 1");
      const successor = sandbox.getSandbox();
      const shutdownBefore = f.shutdown.read();
      f.browser.send.mockClear();
      f.bridge.send.mockClear();
      releaseEncryption();
      await resolution.promise;

      expect(sandbox.getSandbox()).toEqual(successor);
      expect(f.shutdown.read()).toEqual(shutdownBefore);
      expect(f.shutdown.read()?.providerObjectId).toBe(f.reference);
      expect(f.browser.send).not.toHaveBeenCalled();
      expect(f.bridge.send).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.resolve).toHaveBeenCalledExactlyOnceWith({
        sessionId: f.config.sessionId,
        sandboxId: f.generation.sandboxId,
        generationCreatedAtMs: f.generation.createdAt,
        timeoutSeconds: SANDBOX_TIMEOUT_MS / 1000,
      });
      await f.finish();
      expect(sandbox.getSandbox()).toEqual(successor);
      expect(f.shutdown.read()).toEqual(shutdownBefore);
      expect(f.browser.send).not.toHaveBeenCalled();
      expect(f.bridge.send).not.toHaveBeenCalled();
      expect(f.resolve).toHaveBeenCalledOnce();
      expect(f.stop).not.toHaveBeenCalled();
    } finally {
      releaseEncryption();
      await f.finish();
      encrypt.mockRestore();
    }
  });
}

describe("production-wired VM startup reconciliation", () => {
  it.each(["reference", "timestamp"] as const)(
    "refuses a lookup after only its expected %s changes during real encryption",
    refuseEncryptedLookup
  );

  it("reconstructs pending lookup with encrypted access, early readiness and independent admission gates", async () => {
    const stub = await pendingVmSession();
    await runInSessionDO(stub, async (instance, state) => {
      const f = await reconstructedPendingVm(instance, state);
      try {
        const {
          lifecycleManager: manager,
          sandboxRepository: sandbox,
          wsManager,
        } = f.restarted.internals;
        expect(sandbox.getSandbox()?.auth_token_hash).toBe(
          await hashToken(f.config.sandboxAuthToken)
        );
        expect(f.initial.internals.lifecycleManager.isProviderStartupPending()).toBe(true);
        expect(manager.isProviderStartupPending()).toBe(false);
        manager.onSandboxConnected();
        manager.onSandboxSocketAttached(f.generation);
        expect(sandbox.getSandbox()?.status).toBe("connecting");
        expect(wsManager.getSandboxCommandTarget()).toEqual({ kind: "booting", phase: null });
        expect(manager.mayProcessQueuedWork()).toBe(false);
        expect(manager.pushAdmissionDecision()).toBe("held");
        expect(f.shutdown.read()).toMatchObject({
          phase: "running",
          provider: "modal-vm",
          providerObjectId: f.reference,
          lifetimeKind: "finite",
          lifetimeSource: "conservative_start_bound",
          expiresAtMs: f.generation.createdAt + SANDBOX_TIMEOUT_MS,
          drainAtMs: f.generation.createdAt + SANDBOX_TIMEOUT_MS - FINAL_SNAPSHOT_BUFFER_MS,
          generationReady: false,
          lifecyclePolicy: "confirmed",
        });

        expect(manager.onRuntimeReady(Date.now(), "opencode", 1)).toBe(true);
        expect(sandbox.getSandbox()).toMatchObject({
          status: "ready",
          modal_object_id: f.reference,
        });
        expect(wsManager.getSandboxCommandTarget()).toEqual({ kind: "dispatch", socket: f.bridge });
        expect(f.bridge.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "sandbox_generation", generation: f.generation })
        );
        expect(manager.mayProcessQueuedWork()).toBe(false);
        expect(manager.pushAdmissionDecision()).toBe("held");
        const readyWithoutAck = f.shutdown.read();
        manager.onShutdownGenerationReady({
          type: "sandbox_generation_ready",
          sandboxId: f.generation.sandboxId,
          generation: { ...f.generation, createdAt: f.generation.createdAt + 1 },
          timestamp: Date.now(),
        });
        expect(f.shutdown.read()).toEqual(readyWithoutAck);
        manager.onShutdownGenerationReady({
          type: "sandbox_generation_ready",
          sandboxId: f.generation.sandboxId,
          generation: f.generation,
          timestamp: Date.now(),
        });

        // Confirmed pending lifetime plus acknowledgement admits work before lookup completes.
        expect(manager.mayProcessQueuedWork()).toBe(true);
        expect(manager.pushAdmissionDecision()).toBe("ready");
        expect(f.initial.internals.lifecycleManager.mayProcessQueuedWork()).toBe(false);
        expect(f.initial.internals.lifecycleManager.pushAdmissionDecision()).toBe("start_required");
        const acknowledged = f.shutdown.read()!;
        f.shutdown.write({
          ...acknowledged,
          lifetimeKind: "unknown",
          expiresAtMs: null,
          drainAtMs: null,
        });
        expect(manager.mayProcessQueuedWork()).toBe(false);
        expect(manager.pushAdmissionDecision()).toBe("held");
        f.shutdown.write(acknowledged);
        expect(manager.mayProcessQueuedWork()).toBe(true);
        expect(sandbox.getSandbox()).toMatchObject({
          modal_object_id: f.reference,
          code_server_url: null,
          vnc_url: null,
          ttyd_token: null,
        });
        const resolution = f.vmResolution();
        expect(resolution.factory).toEqual(expect.any(Function));
        expect(f.resolve).toHaveBeenCalledExactlyOnceWith({
          sessionId: f.config.sessionId,
          sandboxId: f.generation.sandboxId,
          generationCreatedAtMs: f.generation.createdAt,
          timeoutSeconds: SANDBOX_TIMEOUT_MS / 1000,
        });
        f.browser.send.mockClear();
        f.finishLookup(f.result);
        await resolution.promise;

        expect(sandbox.getSandbox()).toMatchObject({
          status: "ready",
          modal_object_id: "resolved-vm",
          code_server_url: f.result.codeServerUrl,
          code_server_password: expect.any(String),
          vnc_url: f.result.vncAccess!.url,
          vnc_password: expect.any(String),
          ttyd_url: null,
          ttyd_token: null,
          tunnel_urls: JSON.stringify(f.result.tunnelUrls),
        });
        expect(sandbox.getSandbox()?.code_server_password).not.toBe(f.result.codeServerPassword);
        expect(sandbox.getSandbox()?.vnc_password).not.toBe(f.result.vncAccess!.password);
        const reread = createSessionRuntime(f.platform, f.runtimeEnv).internals.sandboxRepository;
        expect(await reread.getSandboxAccessSecret("codeServer")).toBe(f.result.codeServerPassword);
        expect(await reread.getSandboxAccessSecret("vnc")).toBe(f.result.vncAccess!.password);
        expect(await reread.getSandboxAccessSecret("ttyd")).toBeNull();
        expect(f.shutdown.read()).toEqual({ ...acknowledged, providerObjectId: "resolved-vm" });
        expect(f.browser.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "sandbox_access_changed" })
        );
        expect(manager.mayProcessQueuedWork()).toBe(true);
        expect(manager.pushAdmissionDecision()).toBe("ready");
        expect(f.create).toHaveBeenCalledOnce();
        expect(f.stop).not.toHaveBeenCalled();
        // The still-live foreground instance retains signing authority, unlike the reconstructed one.
        await f.finish();
        expect(f.resolve).toHaveBeenCalledTimes(2);
        expect(f.resolve.mock.calls[1][0]).toMatchObject(f.resolve.mock.calls[0][0]);
        expect(sandbox.getSandbox()).toMatchObject({
          status: "ready",
          modal_sandbox_id: f.generation.sandboxId,
          created_at: f.generation.createdAt,
          modal_object_id: "resolved-vm",
          ttyd_url: f.result.ttydUrl,
          last_spawn_error: null,
        });
        expect(await sandbox.getSandboxAccessSecret("codeServer")).toBe(
          f.result.codeServerPassword
        );
        expect(await sandbox.getSandboxAccessSecret("vnc")).toBe(f.result.vncAccess!.password);
        expect(await sandbox.getSandboxAccessSecret("ttyd")).toEqual(expect.any(String));
        expect(f.shutdown.read()).toEqual({ ...acknowledged, providerObjectId: "resolved-vm" });
        expect(f.initial.internals.lifecycleManager.isProviderStartupPending()).toBe(false);
        expect(f.initial.internals.lifecycleManager.mayProcessQueuedWork()).toBe(true);
        expect(f.create).toHaveBeenCalledOnce();
        expect(f.stop).not.toHaveBeenCalled();
      } finally {
        await f.finish();
      }
    });
  });
});
