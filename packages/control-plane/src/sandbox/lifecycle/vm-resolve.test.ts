import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalApiError, type ModalClient, type ResolveVmSandboxResponse } from "../client";
import { ModalSandboxProvider } from "../providers/modal-provider";
import { formatPendingVmReference } from "../providers/pending-vm-reference";
import { RequestDeadlineError } from "../request-deadline";
import { SandboxLifecycleManager } from "./manager";
import type { ImageBuildLookup } from "./image-selection";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "./decisions";
import { SandboxShutdownCoordinator } from "../../session/sandbox-shutdown";
import type { ShutdownRecord } from "../../session/sandbox-shutdown-repository";
import {
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createTestConfig,
} from "./test-helpers";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";

function fixture(action: "create" | "restore" = "create", imageBuildLookup?: ImageBuildLookup) {
  const sandbox = createMockSandbox({
    status: action === "create" ? "pending" : "stopped",
    snapshot_image_id: action === "restore" ? "im-saved" : null,
    snapshot_runtime_version: action === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
  });
  const session = createMockSession({
    code_server_enabled: 1,
    vnc_enabled: 1,
    sandbox_settings: JSON.stringify({ sandboxTimeoutMs: 3_600_000 }),
  });
  const storage = createMockStorage(
    session,
    sandbox,
    undefined,
    imageBuildLookup ? [{ repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" }] : []
  );
  const broadcaster = createMockBroadcaster();
  const wsManager = createMockWebSocketManager();
  const providerResponse: ResolveVmSandboxResponse = {
    sandboxId: "unused",
    modalObjectId: "sb-real",
    sandboxBackend: "modal-vm",
    codeServerUrl: "https://editor.example",
    codeServerPassword: "editor-password",
    vncUrl: "https://desktop.example",
    vncPassword: "desktop-password",
    ttydUrl: "https://terminal.example",
    tunnelUrls: { "8080": "https://port.example" },
  };
  const client = {
    createSandbox: vi.fn(
      async (
        _config: unknown
      ): Promise<{
        sandboxId: string;
        modalObjectId: string;
        sandboxBackend: string;
        createdAt: number;
      }> => {
        throw new RequestDeadlineError("Modal", "createSandbox", 60_000);
      }
    ),
    restoreSandbox: vi.fn(async () => {
      throw new ModalApiError("pending race", 409, "race_pending");
    }),
    resolveVmSandbox: vi.fn(
      async (req: { sandboxId: string }): Promise<ResolveVmSandboxResponse> => ({
        ...providerResponse,
        sandboxId: req.sandboxId,
      })
    ),
    stopSandbox: vi.fn(async () => {}),
  };
  const provider = new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm");
  let state: ShutdownRecord | null = null;
  const store = {
    read: () => (state ? structuredClone(state) : null),
    write: (next: ShutdownRecord) => {
      state = structuredClone(next);
    },
  };
  if (action === "restore") {
    store.write({
      phase: "saved",
      generation: { sandboxId: sandbox.modal_sandbox_id!, createdAt: sandbox.created_at },
      provider: "modal-vm",
      providerObjectId: null,
      sourceRetired: true,
      lifetimeKind: "none",
      expiresAtMs: null,
      drainAtMs: null,
      generationReady: true,
      lifecyclePolicy: "confirmed",
      receipt: {
        kind: "snapshot",
        artifactId: "im-saved",
        provider: "modal-vm",
        savedAtMs: Date.now(),
        runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
      },
    });
  }
  const deps = {
    store,
    provider,
    sandbox: storage,
    session: { getSession: () => session, transaction: <T>(fn: () => T) => fn() },
    messages: { getProcessingMessage: () => null },
    failures: { record: vi.fn(), deliver: vi.fn() },
    messenger: broadcaster,
    sockets: { getSandboxSocket: () => null },
    alarm: createMockAlarmScheduler(),
    background: { submit: vi.fn() },
    onLifecycleChange: vi.fn(async () => {}),
    reconcileStatusFromMessages: vi.fn(async () => {}),
    retireAccess: vi.fn(),
  };
  const makeManager = () =>
    new SandboxLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      wsManager,
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      new SandboxShutdownCoordinator(deps as never),
      createTestConfig(),
      imageBuildLookup
    );
  return { sandbox, storage, broadcaster, client, store, makeManager, wsManager };
}

describe("modal-vm startup resolution", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["create", "restore"] as const)(
    "recovers an unknown %s without resetting lifetime",
    async (action) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      const f = fixture(action);
      const manager = f.makeManager();
      await manager.spawnSandbox();
      expect(f.sandbox.modal_object_id).toBe("sb-real");
      expect(f.sandbox.status).toBe("connecting");
      expect(f.store.read()).toMatchObject({
        providerObjectId: "sb-real",
        expiresAtMs: f.sandbox.created_at + 3_600_000,
      });
      expect(f.sandbox.code_server_url).toBe("https://editor.example");
      expect(f.sandbox.vnc_password).toBe("desktop-password");
      expect(f.sandbox.tunnel_urls).toBe(JSON.stringify({ "8080": "https://port.example" }));
      expect(f.sandbox.ttyd_token).toBeTruthy();
      expect(f.broadcaster.messages).not.toContainEqual(
        expect.objectContaining({ type: "sandbox_error" })
      );
      expect(f.sandbox.spawn_failure_count).toBe(0);
    }
  );

  it("fails once when the allocation remains invisible past the bound, allowing respawn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("invisible", 409, "not_visible"));
    const manager = f.makeManager();
    const spawning = manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    expect(f.sandbox.status).toBe("spawning");
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 16_000);
    await spawning;
    expect(f.sandbox.status).toBe("failed");
    expect(f.broadcaster.messages).toContainEqual(
      expect.objectContaining({ type: "sandbox_error" })
    );
    expect(f.storage.transitionSandboxStatus).toHaveBeenCalledTimes(1);
    f.client.createSandbox.mockResolvedValueOnce({
      sandboxId: "next",
      modalObjectId: "sb-next",
      sandboxBackend: "modal-vm",
      createdAt: Date.now(),
    });
    await manager.spawnSandbox();
    expect(f.client.createSandbox).toHaveBeenCalledTimes(2);
  });

  it("fails definitively for another generation", async () => {
    const f = fixture();
    f.client.resolveVmSandbox.mockRejectedValue(
      new ModalApiError("occupied", 409, "other_generation")
    );
    await f.makeManager().spawnSandbox();
    expect(f.sandbox.status).toBe("failed");
    expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce();
  });

  it("resolves an ambiguous base-image retry after a prebuilt image is unavailable", async () => {
    const imageBuildLookup: ImageBuildLookup = {
      getLatestReady: vi.fn(async () => ({
        id: "image-build-1",
        provider_image_id: "im-prebuilt",
        repositories_fingerprint: await computeRepositoriesFingerprint([
          { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
        ]),
        repository_shas: JSON.stringify([
          { repoOwner: "testowner", repoName: "testrepo", baseSha: "sha-1" },
        ]),
        runtime_version: COMPATIBLE_RUNTIME_VERSION,
      })),
      markRestoreFailed: vi.fn(async () => true),
    };
    const f = fixture("create", imageBuildLookup);
    f.client.createSandbox
      .mockRejectedValueOnce(new ModalApiError("prebuilt unavailable", 410))
      .mockRejectedValueOnce(new RequestDeadlineError("Modal", "createSandbox", 60_000));
    await f.makeManager().spawnSandbox();
    expect(f.client.createSandbox).toHaveBeenCalledTimes(2);
    expect(f.client.createSandbox.mock.calls[1][0]).toMatchObject({ prebuiltImageId: null });
    expect(imageBuildLookup.markRestoreFailed).toHaveBeenCalledOnce();
    expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce();
    expect(f.sandbox.modal_object_id).toBe("sb-real");
  });

  it("bounds repeated transient lookup errors without failing the pending generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("unavailable", 503));
    const manager = f.makeManager();
    const spawning = manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 20_000);
    await spawning;
    expect(manager.isProviderStartupPending()).toBe(false);
    expect(f.sandbox.status).toBe("spawning");
    expect(f.sandbox.modal_object_id).toBe(
      formatPendingVmReference("test-session", f.sandbox.modal_sandbox_id!)
    );
    expect(f.broadcaster.messages).not.toContainEqual(
      expect.objectContaining({ type: "sandbox_error" })
    );
  });

  it("completes a restore after bounded transient errors when its bridge later resolves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture("restore");
    const manager = f.makeManager();
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("unavailable", 503));
    const restoring = manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 10_000);
    await restoring;
    expect(f.store.read()).toMatchObject({ phase: "restoring", restoreInvoked: true });
    f.client.resolveVmSandbox.mockResolvedValue({
      sandboxId: f.sandbox.modal_sandbox_id!,
      modalObjectId: "sb-real",
      sandboxBackend: "modal-vm",
      ttydUrl: "https://terminal.example",
    });
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    manager.onSandboxSocketAttached(generation);
    await vi.waitFor(() => expect(f.store.read()?.phase).toBe("running"));
    expect(manager.onRuntimeReady(Date.now(), undefined, 1)).toBe(true);
    manager.onShutdownGenerationReady({
      type: "sandbox_generation_ready",
      generation,
      sandboxId: generation.sandboxId,
      timestamp: Date.now(),
    });
    expect(f.sandbox.modal_object_id).toBe("sb-real");
    expect(f.sandbox.ttyd_token).toBeTruthy();
    expect(manager.pushAdmissionDecision()).toBe("ready");
  });

  it("claims a bridge-resolved restore when its follow-up lookup stays transient", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture("restore");
    let rejectRestore!: (error: Error) => void;
    f.client.restoreSandbox.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectRestore = reject))
    );
    const manager = f.makeManager();
    const restoring = manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.restoreSandbox).toHaveBeenCalledOnce());
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    manager.onSandboxSocketAttached(generation);
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("unavailable", 503));
    rejectRestore(new ModalApiError("pending race", 409, "race_pending"));
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 10_000);
    await restoring;
    expect(f.store.read()).toMatchObject({ phase: "running", providerObjectId: "sb-real" });
    expect(f.store.read()?.restoreInvoked).toBeUndefined();
    expect(f.sandbox.ttyd_token).toBeTruthy();
  });

  it("claims a bridge result committed during the final inconclusive lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture("restore");
    let rejectLookup!: (error: Error) => void;
    f.client.resolveVmSandbox.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectLookup = reject))
    );
    const manager = f.makeManager();
    const restoring = manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    f.sandbox.status = "connecting";
    const pending = f.sandbox.modal_object_id!;
    f.sandbox.modal_object_id = "sb-real";
    f.store.write({ ...f.store.read()!, providerObjectId: "sb-real" });
    vi.setSystemTime(generation.createdAt + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS);
    rejectLookup(new ModalApiError("invisible", 409, "not_visible"));
    await restoring;
    expect(f.sandbox.modal_object_id).toBe("sb-real");
    expect(f.store.read()?.phase).toBe("running");
    expect(f.store.read()?.restoreInvoked).toBeUndefined();
    expect(pending).toBe(formatPendingVmReference("test-session", generation.sandboxId));
  });

  it("stops resolving when the row is fenced mid-loop", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("invisible", 409, "not_visible"));
    const spawning = f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    f.sandbox.status = "failed";
    f.sandbox.fenced = 1;
    await vi.advanceTimersByTimeAsync(20_000);
    await spawning;
    expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce();
    expect(f.sandbox.modal_object_id).not.toBe("sb-real");
  });

  it("destroys a result that arrives after the row is fenced", async () => {
    const f = fixture();
    let resolve!: (value: ResolveVmSandboxResponse) => void;
    f.client.resolveVmSandbox.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const spawning = f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    f.sandbox.status = "failed";
    f.sandbox.fenced = 1;
    resolve({
      sandboxId: f.sandbox.modal_sandbox_id!,
      modalObjectId: "sb-late",
      sandboxBackend: "modal-vm",
    });
    await spawning;
    expect(f.client.stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "sb-late" }),
      undefined
    );
    expect(f.sandbox.modal_object_id).not.toBe("sb-late");
  });

  it("reconciles a restarted bridge without blocking readiness or writing a replaced generation", async () => {
    const f = fixture();
    const original = f.makeManager();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    void original.spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    expect(f.sandbox.modal_object_id).toBe(
      formatPendingVmReference("test-session", generation.sandboxId)
    );
    let resolve!: (value: Awaited<ReturnType<typeof f.client.resolveVmSandbox>>) => void;
    f.client.resolveVmSandbox.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const restarted = f.makeManager();
    restarted.onSandboxSocketAttached(generation);
    expect(restarted.onRuntimeReady(Date.now(), undefined, 1)).toBe(true);
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    expect(f.sandbox.modal_object_id).not.toBe("sb-real");
    expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce();
    resolve({
      sandboxId: generation.sandboxId,
      modalObjectId: "sb-real",
      sandboxBackend: "modal-vm",
      codeServerUrl: "https://editor.example",
      codeServerPassword: "password",
    });
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
    expect(f.store.read()?.providerObjectId).toBe("sb-real");
    expect(f.store.read()?.expiresAtMs).toBe(generation.createdAt + 3_600_000);
    expect(f.sandbox.ttyd_token).toBeNull();
  });

  it("mints terminal access when the bridge resolves while the original instance holds the token", async () => {
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    const manager = f.makeManager();
    void manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    manager.onSandboxSocketAttached({
      sandboxId: f.sandbox.modal_sandbox_id!,
      createdAt: f.sandbox.created_at,
    });
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
    expect(f.sandbox.ttyd_url).toBe("https://terminal.example");
    expect(f.sandbox.ttyd_token).toBeTruthy();
  });

  it("claims a restore when the bridge resolved its handle before the lost response", async () => {
    const f = fixture("restore");
    let rejectRestore!: (error: Error) => void;
    f.client.restoreSandbox.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectRestore = reject))
    );
    const manager = f.makeManager();
    const restoring = manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.restoreSandbox).toHaveBeenCalledOnce());
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    manager.onSandboxSocketAttached(generation);
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
    expect(f.store.read()).toMatchObject({ phase: "restoring", restoreInvoked: true });

    expect(manager.onRuntimeReady(Date.now(), undefined, 1)).toBe(true);
    f.sandbox.status = "ready";
    manager.onShutdownGenerationReady({
      type: "sandbox_generation_ready",
      generation,
      sandboxId: generation.sandboxId,
      timestamp: Date.now(),
    });
    rejectRestore(new ModalApiError("pending race", 409, "race_pending"));
    await restoring;

    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(2);
    expect(f.store.read()).toMatchObject({ phase: "running", providerObjectId: "sb-real" });
    expect(f.store.read()?.restoreInvoked).toBeUndefined();
    expect(manager.pushAdmissionDecision()).toBe("ready");
    expect(f.sandbox.modal_object_id).toBe("sb-real");
  });

  it("does not attach bridge access to a newer generation", async () => {
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    void f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    let resolve!: (value: ResolveVmSandboxResponse) => void;
    f.client.resolveVmSandbox.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const restarted = f.makeManager();
    restarted.onSandboxSocketAttached({
      sandboxId: f.sandbox.modal_sandbox_id!,
      createdAt: f.sandbox.created_at,
    });
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    const oldSandboxId = f.sandbox.modal_sandbox_id!;
    f.sandbox.modal_sandbox_id = "newer-generation";
    f.sandbox.created_at += 1;
    f.sandbox.modal_object_id = "sb-newer";
    resolve({ sandboxId: oldSandboxId, modalObjectId: "sb-real", sandboxBackend: "modal-vm" });
    await vi.waitFor(() => expect(f.storage.completeProviderResume).toHaveBeenCalledOnce());
    expect(f.sandbox.modal_object_id).toBe("sb-newer");
    expect(f.store.read()?.providerObjectId).not.toBe("sb-real");
  });

  it("retries transient bridge lookups after readiness until the same generation resolves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    void f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    f.client.resolveVmSandbox
      .mockRejectedValueOnce(new ModalApiError("invisible", 409, "not_visible"))
      .mockRejectedValueOnce(new ModalApiError("unavailable", 503));
    const restarted = f.makeManager();
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    restarted.onSandboxSocketAttached(generation);
    expect(restarted.onRuntimeReady(Date.now(), undefined, 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(3);
    expect(f.sandbox.modal_object_id).toBe("sb-real");
  });

  it("retries a transient bridge error even when the generation predates the visibility bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.sandbox.status = "ready";
    f.sandbox.created_at = Date.now() - PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS - 1;
    f.sandbox.modal_object_id = formatPendingVmReference(
      "test-session",
      f.sandbox.modal_sandbox_id!
    );
    f.client.resolveVmSandbox.mockRejectedValueOnce(new ModalApiError("unavailable", 503));
    f.makeManager().onSandboxSocketAttached({
      sandboxId: f.sandbox.modal_sandbox_id!,
      createdAt: f.sandbox.created_at,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(2);
    expect(f.sandbox.modal_object_id).toBe("sb-real");
  });

  it("stops bridge retries after the bounded window while leaving the pending handle intact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    void f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("unavailable", 503));
    const restarted = f.makeManager();
    restarted.onSandboxSocketAttached({
      sandboxId: f.sandbox.modal_sandbox_id!,
      createdAt: f.sandbox.created_at,
    });
    expect(restarted.onRuntimeReady(Date.now(), undefined, 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 20_000);
    const attempts = f.client.resolveVmSandbox.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(attempts);
    expect(f.sandbox.modal_object_id).toBe(
      formatPendingVmReference("test-session", f.sandbox.modal_sandbox_id!)
    );
  });

  it("retries the newer generation if its bridge attaches during an older lookup", async () => {
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    void f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    const restarted = f.makeManager();
    let rejectFirst!: (error: Error) => void;
    f.client.resolveVmSandbox.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectFirst = reject))
    );
    restarted.onSandboxSocketAttached({
      sandboxId: f.sandbox.modal_sandbox_id!,
      createdAt: f.sandbox.created_at,
    });
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    const newer = { sandboxId: "newer-generation", createdAt: f.sandbox.created_at + 1 };
    f.sandbox.modal_sandbox_id = newer.sandboxId;
    f.sandbox.created_at = newer.createdAt;
    f.sandbox.modal_object_id = formatPendingVmReference("test-session", newer.sandboxId);
    f.sandbox.status = "connecting";
    restarted.onSandboxSocketAttached(newer);
    restarted.onRuntimeReady(Date.now(), undefined, 1);
    rejectFirst(new ModalApiError("invisible", 409, "not_visible"));
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(2));
    expect(f.client.resolveVmSandbox.mock.calls[1][0]).toMatchObject({
      sandboxId: newer.sandboxId,
    });
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
  });
});
