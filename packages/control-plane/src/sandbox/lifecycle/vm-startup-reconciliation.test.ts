import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalApiError } from "../client";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type ResolveSandboxResult,
} from "../provider";
import { formatPendingVmReference } from "../providers/pending-vm-reference";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "./decisions";
import { SandboxLaunchExpiredError, SpawnSupersededError } from "./startup-errors";
import { createMockSandbox, createMockSession } from "./test-helpers";
import {
  VmStartupReconciliation,
  type VmStartupReconciliationDependencies,
} from "./vm-startup-reconciliation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture() {
  const generation = { sandboxId: "logical-vm", createdAt: Date.now() };
  const reference = formatPendingVmReference("test-session", generation.sandboxId);
  const row = createMockSandbox({
    status: "connecting",
    modal_sandbox_id: generation.sandboxId,
    created_at: generation.createdAt,
    modal_object_id: reference,
  });
  const session = createMockSession();
  const lifetime = {
    kind: "finite" as const,
    source: "conservative_start_bound" as const,
    observedAtMs: generation.createdAt,
    expiresAtMs: generation.createdAt + 3_600_000,
  };
  const result: ResolveSandboxResult = {
    sandboxId: generation.sandboxId,
    providerObjectId: "sb-real",
    lifetime,
    ttydUrl: "https://terminal.example",
    codeServerUrl: "https://editor.example",
    codeServerPassword: "editor-secret",
    vncAccess: { url: "https://desktop.example", password: "desktop-secret" },
    tunnelUrls: { "8080": "https://port.example" },
  };
  const config: CreateSandboxConfig = {
    sessionId: "test-session",
    sandboxId: generation.sandboxId,
    generationCreatedAtMs: generation.createdAt,
    timeoutSeconds: 3600,
    repoOwner: null,
    repoName: null,
    controlPlaneUrl: "https://control.example",
    sandboxAuthToken: "launch-key",
    harness: "opencode",
    provider: "openai",
    model: "gpt-5.4",
  };
  const work: Promise<unknown>[] = [];
  const deps = {
    provider: {
      name: "modal-vm",
      createSandbox: vi.fn(async () => ({ ...result, createdAt: generation.createdAt })),
      pendingSandboxAllocation: vi.fn(() => ({ reference, lifetime })),
      isUnknownStartupError: vi.fn((error: unknown) => error instanceof TypeError),
      resolveSandbox: vi.fn(async (): Promise<ResolveSandboxResult> => result),
    },
    storage: {
      getSandbox: vi.fn(() => row),
      updateSandboxModalObjectId: vi.fn((id: string | null) => {
        row.modal_object_id = id;
      }),
      completeProviderResume: vi.fn<
        VmStartupReconciliationDependencies["storage"]["completeProviderResume"]
      >(async (target, access, expectedReference) => {
        if (
          row.modal_sandbox_id !== target.sandboxId ||
          row.created_at !== target.createdAt ||
          row.fenced ||
          !["connecting", "ready"].includes(row.status) ||
          row.modal_object_id !== expectedReference
        )
          return false;
        row.modal_object_id = access.providerObjectId;
        return true;
      }),
    },
    shutdown: {
      recordPendingProviderHandle: vi.fn<
        VmStartupReconciliationDependencies["shutdown"]["recordPendingProviderHandle"]
      >(async () => "registered"),
      recordResolvedProviderHandle: vi.fn(),
    },
    sessionContext: { getSession: vi.fn(() => session) },
    launchContext: {
      resolveSandboxSettings: vi.fn(() => ({ sandboxSettings: {}, timeoutSeconds: 3600 })),
    },
    access: {
      mintTtydToken: vi.fn(async () => "signed-terminal-token"),
      broadcastProviderAccessIfConnected: vi.fn(),
    },
    acceptResolvedStartup: vi.fn(async () => true),
    getLogger: vi.fn(() => ({ warn: vi.fn() })),
    backgroundTasks: {
      submit: vi.fn((task: () => Promise<unknown>) => {
        work.push(task());
      }),
    },
  } satisfies VmStartupReconciliationDependencies;
  const reconciliation = new VmStartupReconciliation(deps);
  return { reconciliation, deps, work, generation, reference, row, result, config, lifetime };
}

describe("VM startup reconciliation boundaries", () => {
  afterEach(() => vi.useRealTimers());

  it("constructs lazily and enters the background factory synchronously", async () => {
    const f = fixture();
    expect(f.deps.sessionContext.getSession).not.toHaveBeenCalled();
    expect(f.deps.getLogger).not.toHaveBeenCalled();
    expect(f.deps.launchContext.resolveSandboxSettings).not.toHaveBeenCalled();
    f.reconciliation.resolvePendingBridge(f.generation);
    expect(f.deps.provider.resolveSandbox).toHaveBeenCalledExactlyOnceWith({
      sessionId: "test-session",
      sandboxId: f.generation.sandboxId,
      generationCreatedAtMs: f.generation.createdAt,
      timeoutSeconds: 3600,
    });
    await f.work[0];
  });

  it.each(["same object", "equal values", "older generation"] as const)(
    "%s foreground finalization preserves its identity-sensitive token ownership",
    async (mode) => {
      const f = fixture();
      f.reconciliation.registerForegroundAuth(f.generation, "test-session", "current-key");
      const finalizer =
        mode === "same object"
          ? f.generation
          : {
              ...f.generation,
              createdAt: f.generation.createdAt - (mode === "older generation" ? 1 : 0),
            };
      f.reconciliation.finalizeForeground(finalizer);
      f.reconciliation.resolvePendingBridge({ ...f.generation });
      await f.work[0];
      if (mode === "same object") expect(f.deps.access.mintTtydToken).not.toHaveBeenCalled();
      else
        expect(f.deps.access.mintTtydToken).toHaveBeenCalledExactlyOnceWith(
          "current-key",
          "test-session",
          f.generation.sandboxId
        );
    }
  );

  it("clears retry auth before replacement and does not let an old finalizer clear new auth", async () => {
    const f = fixture();
    const newer = { ...f.generation, createdAt: f.generation.createdAt + 1 };
    f.reconciliation.registerForegroundAuth(f.generation, "test-session", "old-key");
    f.reconciliation.beginForegroundRetry();
    f.row.created_at = newer.createdAt;
    f.reconciliation.resolvePendingBridge(newer);
    await f.work[0];
    expect(f.deps.access.mintTtydToken).not.toHaveBeenCalled();

    f.row.modal_object_id = f.reference;
    f.reconciliation.registerForegroundAuth(newer, "test-session", "new-key");
    f.reconciliation.finalizeForeground(f.generation);
    f.reconciliation.resolvePendingBridge({ ...newer });
    await f.work[1];
    expect(f.deps.access.mintTtydToken).toHaveBeenCalledExactlyOnceWith(
      "new-key",
      "test-session",
      newer.sandboxId
    );
  });

  it("hands an inconclusive foreground lookup to an equal-valued bridge and clears completed auth", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.reconciliation.registerForegroundAuth(f.generation, "test-session", "launch-key");
    f.deps.provider.resolveSandbox.mockRejectedValueOnce(new TypeError("transport unknown"));
    vi.setSystemTime(f.generation.createdAt + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS);
    await expect(
      f.reconciliation.resolveUnknownVmStartup(f.generation, f.config)
    ).resolves.toBeNull();
    f.reconciliation.finalizeForeground(f.generation);
    f.reconciliation.resolvePendingBridge({ ...f.generation });
    await f.work[0];
    expect(f.deps.acceptResolvedStartup).toHaveBeenCalledExactlyOnceWith(
      f.generation,
      "sb-real",
      f.lifetime
    );
    expect(f.deps.access.mintTtydToken).toHaveBeenCalledOnce();
    expect(f.deps.shutdown.recordResolvedProviderHandle).not.toHaveBeenCalled();
    f.row.modal_object_id = f.reference;
    f.reconciliation.resolvePendingBridge({ ...f.generation });
    await f.work[1];
    expect(f.deps.access.mintTtydToken).toHaveBeenCalledOnce();
    expect(f.deps.provider.createSandbox).not.toHaveBeenCalled();
  });

  it("reuses only cached identity and lifetime, never provider credentials", async () => {
    const f = fixture();
    f.reconciliation.registerForegroundAuth(f.generation, "test-session", "launch-key");
    f.reconciliation.resolvePendingBridge({ ...f.generation });
    await f.work[0];
    f.result.codeServerPassword = "mutated-secret";
    await expect(f.reconciliation.resolveUnknownVmStartup(f.generation, f.config)).resolves.toEqual(
      {
        sandboxId: f.generation.sandboxId,
        providerObjectId: "sb-real",
        lifetime: f.lifetime,
      }
    );
    expect(f.deps.provider.resolveSandbox).toHaveBeenCalledOnce();
    f.row.created_at += 1;
    await expect(
      f.reconciliation.resolveUnknownVmStartup(f.generation, f.config)
    ).resolves.toBeNull();
    expect(f.deps.provider.resolveSandbox).toHaveBeenCalledOnce();
  });

  it.each(["fenced", "stopped", "replaced", "reference changed"] as const)(
    "publishes nothing when atomic bridge completion refuses a %s row",
    async (change) => {
      const f = fixture();
      const completion = deferred<boolean>();
      const entered = deferred<void>();
      const commit = f.deps.storage.completeProviderResume.getMockImplementation()!;
      f.deps.storage.completeProviderResume.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await completion.promise;
        return commit(...args);
      });
      f.reconciliation.resolvePendingBridge(f.generation);
      await entered.promise;
      if (change === "fenced") f.row.fenced = 1;
      if (change === "stopped") f.row.status = "stopped";
      if (change === "replaced") f.row.created_at += 1;
      if (change === "reference changed") f.row.modal_object_id = "new-reference";
      const successor = { ...f.row };
      completion.resolve(true);
      await f.work[0];
      expect(f.row).toEqual(successor);
      expect(f.deps.acceptResolvedStartup).not.toHaveBeenCalled();
      expect(f.deps.shutdown.recordResolvedProviderHandle).not.toHaveBeenCalled();
      expect(f.deps.access.broadcastProviderAccessIfConnected).not.toHaveBeenCalled();
      expect(f.deps.storage.completeProviderResume.mock.calls[0][2]).toBe(f.reference);
    }
  );

  it("queues the latest timestamp generation after an older successful lookup without adopting it", async () => {
    const f = fixture();
    const lookup = deferred<ResolveSandboxResult>();
    f.deps.provider.resolveSandbox.mockReturnValueOnce(lookup.promise);
    f.reconciliation.registerForegroundAuth(f.generation, "test-session", "old-key");
    f.reconciliation.resolvePendingBridge(f.generation);
    f.reconciliation.resolvePendingBridge({ ...f.generation });
    expect(f.deps.backgroundTasks.submit).toHaveBeenCalledOnce();
    const newer = { ...f.generation, createdAt: f.generation.createdAt + 1 };
    f.reconciliation.resolvePendingBridge(newer);
    const latest = { ...newer, createdAt: newer.createdAt + 1 };
    f.row.created_at = latest.createdAt;
    f.reconciliation.registerForegroundAuth(latest, "test-session", "latest-key");
    f.reconciliation.resolvePendingBridge(latest);
    lookup.resolve({ ...f.result, providerObjectId: "sb-old" });
    await f.work[0];
    expect(f.work).toHaveLength(2);
    await f.work[1];
    expect(f.deps.provider.resolveSandbox).toHaveBeenCalledTimes(2);
    expect(f.deps.provider.resolveSandbox.mock.calls[1]).toEqual([
      expect.objectContaining({
        generationCreatedAtMs: latest.createdAt,
      }),
    ]);
    expect(f.deps.access.mintTtydToken).toHaveBeenCalledExactlyOnceWith(
      "latest-key",
      "test-session",
      latest.sandboxId
    );
    expect(f.deps.shutdown.recordResolvedProviderHandle).toHaveBeenCalledExactlyOnceWith(
      latest,
      f.reference,
      "sb-real"
    );
    expect(f.row.modal_object_id).toBe("sb-real");
    expect(f.deps.acceptResolvedStartup).not.toHaveBeenCalled();
  });

  it.each(["expired", "superseded"] as const)(
    "preserves pending-registration %s classification without dispatching create",
    async (outcome) => {
      const f = fixture();
      f.row.modal_object_id = "prior-handle";
      f.deps.shutdown.recordPendingProviderHandle.mockResolvedValueOnce(outcome);
      await expect(
        f.reconciliation.recordPendingProviderReference(f.generation, f.config)
      ).rejects.toBeInstanceOf(
        outcome === "expired" ? SandboxLaunchExpiredError : SpawnSupersededError
      );
      expect(f.row.modal_object_id).toBe(outcome === "expired" ? "prior-handle" : f.reference);
      expect(f.deps.shutdown.recordPendingProviderHandle.mock.calls[0][0]).toBe(f.generation);
      expect(f.deps.provider.createSandbox).not.toHaveBeenCalled();
    }
  );

  it("does not turn null recovery into another create", async () => {
    const f = fixture();
    f.deps.provider.createSandbox.mockRejectedValueOnce(new TypeError("lost create"));
    f.row.fenced = 1;
    await expect(f.reconciliation.createWithVmRecovery(f.config, f.generation)).resolves.toBeNull();
    expect(f.deps.provider.createSandbox).toHaveBeenCalledOnce();
    expect(f.deps.provider.resolveSandbox).not.toHaveBeenCalled();
  });

  it("does not infer VM support from hooks that return no pending allocation", async () => {
    const f = fixture();
    const provider = {
      ...f.deps.provider,
      name: "modal",
      pendingSandboxAllocation: vi.fn(() => undefined),
      isUnknownStartupError: vi.fn(() => false),
    };
    const reconciliation = new VmStartupReconciliation({ ...f.deps, provider });
    f.row.modal_object_id = "ordinary-handle";
    reconciliation.registerForegroundAuth(f.generation, "test-session", "unused-key");
    await reconciliation.recordPendingProviderReference(f.generation, f.config);
    await reconciliation.createWithVmRecovery(f.config, f.generation);
    reconciliation.resolvePendingBridge(f.generation);
    expect(f.deps.storage.updateSandboxModalObjectId).not.toHaveBeenCalled();
    expect(f.deps.shutdown.recordPendingProviderHandle).not.toHaveBeenCalled();
    expect(provider.resolveSandbox).not.toHaveBeenCalled();
    expect(f.deps.access.mintTtydToken).not.toHaveBeenCalled();
    expect(f.deps.launchContext.resolveSandboxSettings).not.toHaveBeenCalled();
    expect(f.deps.backgroundTasks.submit).not.toHaveBeenCalled();
  });

  it("distinguishes not-visible from transport uncertainty and another generation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.setSystemTime(f.generation.createdAt + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS);
    f.deps.provider.resolveSandbox.mockRejectedValueOnce(
      new ModalApiError("invisible", 409, "not_visible")
    );
    await expect(
      f.reconciliation.resolveUnknownVmStartup(f.generation, f.config)
    ).rejects.toMatchObject({
      errorType: "transient",
    });
    const occupied = new SandboxProviderError(
      "occupied",
      "permanent",
      new ModalApiError("occupied", 409, "other_generation")
    );
    f.deps.provider.resolveSandbox.mockRejectedValueOnce(occupied);
    await expect(f.reconciliation.resolveUnknownVmStartup(f.generation, f.config)).rejects.toBe(
      occupied
    );
    f.deps.provider.resolveSandbox.mockRejectedValueOnce(new TypeError("unknown transport"));
    await expect(
      f.reconciliation.resolveUnknownVmStartup(f.generation, f.config)
    ).resolves.toBeNull();
    expect(f.deps.provider.createSandbox).not.toHaveBeenCalled();
  });
});
