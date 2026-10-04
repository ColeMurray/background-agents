import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalApiError, type ResolveVmSandboxResponse } from "../client";
import { formatPendingVmReference } from "../providers/pending-vm-reference";
import { RequestDeadlineError } from "../request-deadline";
import type { ImageBuildLookup } from "./image-selection";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "./decisions";
import { SandboxShutdownCoordinator } from "../../session/sandbox-shutdown";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { fixture } from "./vm-resolve.test-fixture";

describe("modal-vm startup resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves bridge settings only after the pending-reference eligibility checks", async () => {
    const f = fixture();
    f.sandbox.status = "ready";
    const settingsRead = vi.fn(() => '{"sandboxTimeoutMs":3600000}');
    Object.defineProperty(f.session, "sandbox_settings", { get: settingsRead });
    const resolveSandbox = vi.spyOn(f.provider, "resolveSandbox");
    const manager = f.makeManager();
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    expect(settingsRead).not.toHaveBeenCalled();
    manager.onSandboxSocketAttached(generation);
    f.sandbox.modal_object_id = formatPendingVmReference("another-session", generation.sandboxId);
    manager.onSandboxSocketAttached(generation);
    expect(settingsRead).not.toHaveBeenCalled();
    expect(f.client.resolveVmSandbox).not.toHaveBeenCalled();

    f.sandbox.modal_object_id = formatPendingVmReference("test-session", generation.sandboxId);
    manager.onSandboxSocketAttached(generation);
    expect(settingsRead).toHaveBeenCalledOnce();
    expect(resolveSandbox).toHaveBeenCalledExactlyOnceWith({
      sessionId: "test-session",
      sandboxId: generation.sandboxId,
      generationCreatedAtMs: generation.createdAt,
      timeoutSeconds: 3600,
    });
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
  });

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

  it("fails a create rejected before allocation without resolving, counting the failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.client.createSandbox.mockRejectedValue(
      new ModalApiError("Modal API error: 501", 501, "docker_not_available")
    );
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("invisible", 409, "not_visible"));
    const spawning = f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 20_000);
    await spawning;
    expect(f.client.resolveVmSandbox).not.toHaveBeenCalled();
    expect(f.sandbox.status).toBe("failed");
    expect(f.sandbox.spawn_failure_count).toBe(1);
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

  it("retains the foreground token for an equal-valued bridge claim after inconclusive lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("unavailable", 503));
    const manager = f.makeManager();
    const spawning = manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 20_000);
    await spawning;
    expect(f.sandbox.status).toBe("spawning");
    expect(f.sandbox.ttyd_token).toBeNull();
    expect(f.client.createSandbox).toHaveBeenCalledOnce();

    f.client.resolveVmSandbox.mockResolvedValue({
      sandboxId: f.sandbox.modal_sandbox_id!,
      modalObjectId: "sb-real",
      sandboxBackend: "modal-vm",
      ttydUrl: "https://terminal.example",
    });
    manager.onSandboxSocketAttached({
      sandboxId: f.sandbox.modal_sandbox_id!,
      createdAt: f.sandbox.created_at,
    });
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
    expect(f.sandbox.ttyd_token).toBeTruthy();
    expect(f.store.read()).toMatchObject({ phase: "running", providerObjectId: "sb-real" });
    expect(f.client.createSandbox).toHaveBeenCalledOnce();
  });

  it("does not announce bridge access when shutdown becomes held during access completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    let lookupEntered!: () => void;
    const lookupStarted = new Promise<void>((resolve) => (lookupEntered = resolve));
    f.client.resolveVmSandbox.mockImplementation(async () => {
      lookupEntered();
      throw new ModalApiError("unavailable", 503);
    });
    const manager = f.makeManager();
    const spawning = manager.spawnSandbox();
    await lookupStarted;
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 20_000);
    await spawning;

    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    const pending = f.sandbox.modal_object_id;
    f.client.stopSandbox.mockClear();
    f.client.resolveVmSandbox.mockResolvedValue({
      sandboxId: generation.sandboxId,
      modalObjectId: "sb-real",
      sandboxBackend: "modal-vm",
      ttydUrl: "https://terminal.example",
    });
    let completeEntered!: () => void;
    const completing = new Promise<void>((resolve) => (completeEntered = resolve));
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => (releaseCompletion = resolve));
    const complete = vi.mocked(f.storage.completeProviderResume).getMockImplementation()!;
    vi.mocked(f.storage.completeProviderResume).mockImplementationOnce(async (...args) => {
      completeEntered();
      await completionGate;
      return complete(...args);
    });
    let work!: Promise<unknown>;
    f.backgroundTasks.submit.mockImplementation((task) => {
      work = task();
    });
    vi.mocked(f.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
    manager.onSandboxSocketAttached(generation);
    await completing;
    const held = {
      ...f.store.read()!,
      phase: "unknown" as const,
      error: "Shutdown held during completion",
    };
    f.store.write(held);
    releaseCompletion();
    await work;

    expect(f.sandbox.modal_object_id).toBe("sb-real");
    expect(f.sandbox.ttyd_token).toBeTruthy();
    expect(f.storage.completeProviderResume).toHaveBeenCalledWith(
      generation,
      expect.objectContaining({ providerObjectId: "sb-real" }),
      pending
    );
    expect(f.store.read()).toEqual(held);
    expect(f.client.stopSandbox).not.toHaveBeenCalled();
    expect(manager.isProviderStartupPending()).toBe(false);
    expect(f.broadcaster.messages).not.toContainEqual({ type: "sandbox_access_changed" });
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

  it("claims a bridge-resolved restore without a second network lookup", async () => {
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
    rejectRestore(new ModalApiError("pending race", 409, "race_pending"));
    await restoring;
    expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce();
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
    expect(f.sandbox.auth_token).toBeNull();
    expect(f.sandbox.auth_token_hash).toBeTruthy();
    let resolve!: (value: Awaited<ReturnType<typeof f.client.resolveVmSandbox>>) => void;
    f.client.resolveVmSandbox.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const restarted = f.makeManager();
    restarted.onSandboxSocketAttached(generation);
    expect(f.backgroundTasks.submit).toHaveBeenCalledWith(expect.any(Function), {
      name: "sandbox.vm_resolve",
    });
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
      ttydUrl: "https://terminal.example",
    });
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
    expect(f.store.read()?.providerObjectId).toBe("sb-real");
    expect(f.store.read()?.expiresAtMs).toBe(generation.createdAt + 3_600_000);
    expect(f.sandbox.ttyd_url).toBeNull();
    expect(f.sandbox.ttyd_token).toBeNull();
    expect(f.storage.completeProviderResume).toHaveBeenCalledExactlyOnceWith(
      generation,
      {
        providerObjectId: "sb-real",
        codeServer: { url: "https://editor.example", password: "password" },
        vnc: null,
        ttyd: null,
        tunnelUrls: null,
      },
      formatPendingVmReference("test-session", generation.sandboxId)
    );
    expect(f.storage.updateSandboxAccess).not.toHaveBeenCalled();
    expect(f.storage.updateSandboxTunnelUrls).not.toHaveBeenCalled();
  });

  it("mints terminal access when the bridge resolves while the original instance holds the token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    const manager = f.makeManager();
    void manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    const createConfig = f.client.createSandbox.mock.calls[0][0];
    expect(createConfig.sessionId).toBe("test-session");
    const generation = {
      sandboxId: f.sandbox.modal_sandbox_id!,
      createdAt: f.sandbox.created_at,
    };
    expect(f.sandbox.auth_token).toBeNull();
    expect(f.sandbox.auth_token_hash).toBeTruthy();
    expect(createConfig.sandboxAuthToken).not.toBe(f.sandbox.auth_token_hash);
    manager.onSandboxSocketAttached(generation);
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
    expect(f.sandbox.ttyd_url).toBe("https://terminal.example");
    expect(f.sandbox.ttyd_token).toBeTruthy();
    const token = f.sandbox.ttyd_token!;
    const [header, payload, signature] = token.split(".");
    expect(token.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({
      sub: createConfig.sessionId,
      sid: generation.sandboxId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    });
    for (const [secret, valid] of [
      [createConfig.sandboxAuthToken, true],
      [f.sandbox.auth_token_hash!, false],
    ] as const) {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      );
      await expect(
        crypto.subtle.verify(
          "HMAC",
          key,
          Buffer.from(signature, "base64url"),
          new TextEncoder().encode(`${header}.${payload}`)
        )
      ).resolves.toBe(valid);
    }
    expect(f.storage.completeProviderResume).toHaveBeenCalledExactlyOnceWith(
      generation,
      {
        providerObjectId: "sb-real",
        codeServer: { url: "https://editor.example", password: "editor-password" },
        vnc: { url: "https://desktop.example", password: "desktop-password" },
        ttyd: { url: "https://terminal.example", token },
        tunnelUrls: { "8080": "https://port.example" },
      },
      formatPendingVmReference(createConfig.sessionId, generation.sandboxId)
    );
    expect(f.storage.updateSandboxAccess).not.toHaveBeenCalled();
    expect(f.storage.updateSandboxTunnelUrls).not.toHaveBeenCalled();
  });

  it("retains a committed bridge identity when access publication fails in the background", async () => {
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    const manager = f.makeManager();
    void manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    const pending = f.sandbox.modal_object_id!;
    f.client.stopSandbox.mockClear();
    f.sandbox.spawn_failure_count = 2;
    f.sandbox.last_spawn_failure = Date.now() - 1000;
    const lastSpawnFailure = f.sandbox.last_spawn_failure;
    const shutdownBefore = f.store.read()!;
    const holdFailedRecovery = vi.spyOn(SandboxShutdownCoordinator.prototype, "holdFailedRecovery");
    const holdFailedRetainedBoot = vi.spyOn(
      SandboxShutdownCoordinator.prototype,
      "holdFailedRetainedBoot"
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(f.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
    vi.mocked(f.broadcaster.broadcast).mockImplementation((message) => {
      if (message.type === "sandbox_access_changed") {
        throw new Error("access publication unavailable");
      }
      f.broadcaster.messages.push(message);
    });
    let work!: Promise<unknown>;
    f.backgroundTasks.submit.mockImplementation((task) => {
      work = task();
    });

    manager.onSandboxSocketAttached(generation);
    await expect(work).resolves.toBeUndefined();

    expect(warning.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "sandbox.vm_resolve_failed",
        msg: "Bridge VM resolution failed",
        error: "access publication unavailable",
      })
    );
    expect(f.sandbox).toMatchObject({
      modal_sandbox_id: generation.sandboxId,
      created_at: generation.createdAt,
      modal_object_id: "sb-real",
      status: "connecting",
      fenced: 0,
      startup_rejected: 0,
      code_server_url: "https://editor.example",
      code_server_password: "editor-password",
      vnc_url: "https://desktop.example",
      vnc_password: "desktop-password",
      ttyd_url: "https://terminal.example",
      ttyd_token: expect.any(String),
      tunnel_urls: JSON.stringify({ "8080": "https://port.example" }),
      last_spawn_error: null,
      last_spawn_error_at: null,
      spawn_failure_count: 2,
      last_spawn_failure: lastSpawnFailure,
    });
    expect(f.store.read()).toEqual({ ...shutdownBefore, providerObjectId: "sb-real" });
    expect(f.storage.completeProviderResume).toHaveBeenCalledExactlyOnceWith(
      generation,
      expect.objectContaining({ providerObjectId: "sb-real" }),
      pending
    );
    expect(f.storage.transitionSandboxStatus).toHaveBeenCalledExactlyOnceWith(
      generation,
      "spawning",
      "connecting"
    );
    expect(f.storage.updateSandboxStatus).not.toHaveBeenCalled();
    expect(f.storage.rejectProviderStartup).not.toHaveBeenCalled();
    expect(f.storage.fenceSandboxGeneration).not.toHaveBeenCalled();
    expect(f.storage.incrementCircuitBreakerFailure).not.toHaveBeenCalled();
    expect(f.storage.resetCircuitBreaker).not.toHaveBeenCalled();
    expect(holdFailedRecovery).not.toHaveBeenCalled();
    expect(holdFailedRetainedBoot).not.toHaveBeenCalled();
    expect(f.client.stopSandbox).not.toHaveBeenCalled();
    expect(f.broadcaster.messages).not.toContainEqual(
      expect.objectContaining({ type: "sandbox_error" })
    );
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

    expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce();
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
    let work!: Promise<unknown>;
    f.backgroundTasks.submit.mockImplementation((task) => {
      work = task();
    });
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
    Object.assign(f.sandbox, {
      code_server_url: "https://newer-editor.example",
      code_server_password: "newer-editor-password",
      vnc_url: "https://newer-desktop.example",
      vnc_password: "newer-desktop-password",
      ttyd_url: "https://newer-terminal.example",
      ttyd_token: "newer-terminal-token",
      tunnel_urls: JSON.stringify({ "3000": "https://newer-port.example" }),
    });
    const successor = { ...f.sandbox };
    const shutdownBefore = f.store.read();
    resolve({
      sandboxId: oldSandboxId,
      modalObjectId: "sb-real",
      sandboxBackend: "modal-vm",
      codeServerUrl: "https://late-editor.example",
      codeServerPassword: "late-editor-password",
      vncUrl: "https://late-desktop.example",
      vncPassword: "late-desktop-password",
      ttydUrl: "https://late-terminal.example",
      tunnelUrls: { "8080": "https://late-port.example" },
    });
    await expect(work).resolves.toBeUndefined();
    expect(f.storage.completeProviderResume).toHaveBeenCalledOnce();
    expect(f.sandbox).toEqual(successor);
    expect(f.sandbox.modal_object_id).toBe("sb-newer");
    expect(f.store.read()).toEqual(shutdownBefore);
    expect(f.store.read()?.providerObjectId).not.toBe("sb-real");
    expect(f.storage.updateSandboxAccess).not.toHaveBeenCalled();
    expect(f.storage.updateSandboxTunnelUrls).not.toHaveBeenCalled();
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
