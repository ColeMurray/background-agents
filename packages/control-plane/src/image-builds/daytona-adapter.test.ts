import { describe, expect, it, vi } from "vitest";
import type {
  DaytonaSandboxResponse,
  DaytonaSnapshotResponse,
} from "../sandbox/daytona-rest-client";
import type { ImageBuildProviderTriggerConfig } from "../sandbox/provider";
import type { DaytonaSandboxProvider } from "../sandbox/providers/daytona-provider";
import { DaytonaImageBuildAdapter } from "./daytona-adapter";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import type { ImageBuildPlan, FinalizeImageBuildInput } from "./types";

const BUILD_ID = "imgb-acme-web-1757000000000-ab12";
const SOURCE_ID = "sandbox-abc123";
const correlation = { request_id: "request-1", trace_id: "trace-1" };

function baseProvider() {
  return {
    triggerImageBuild: vi.fn(async (_config: ImageBuildProviderTriggerConfig) => undefined),
    getBuildSandbox: vi.fn(
      async (): Promise<DaytonaSandboxResponse | null> => ({
        id: SOURCE_ID,
        state: "started",
        labels: { openinspect_expires_at: String(Date.now() + 60 * 60_000) },
      })
    ),
    stopBuildSandboxForCapture: vi.fn(async (): Promise<"stopped" | "stopping"> => "stopped"),
    captureBuildSnapshot: vi.fn(async () => undefined),
    getBuildSnapshot: vi.fn(
      async (): Promise<DaytonaSnapshotResponse | null> => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "active",
        sourceSandboxId: SOURCE_ID,
      })
    ),
    deleteBuildSandbox: vi.fn(async () => undefined),
    deleteProviderImage: vi.fn(async () => undefined),
    findBuildSandboxByName: vi.fn(async (): Promise<DaytonaSandboxResponse | null> => null),
  };
}

type ProviderMock = ReturnType<typeof baseProvider>;

function createProvider(overrides: Partial<ProviderMock> = {}): ProviderMock {
  return { ...baseProvider(), ...overrides };
}

function createAdapter(provider: ProviderMock) {
  return new DaytonaImageBuildAdapter(provider as unknown as DaytonaSandboxProvider);
}

function plan(overrides: Partial<ImageBuildPlan> = {}): ImageBuildPlan {
  return {
    buildId: BUILD_ID,
    scope: { kind: "repo", id: "acme/web" },
    repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    buildTimeoutMs: 1_800_000,
    correlation,
    callbackToken: "a".repeat(64),
    cloneAuth: { type: "credential_helper", host: "github.com", username: "x", token: "clone-1" },
    ...overrides,
  };
}

function finalizeInput(overrides: Partial<FinalizeImageBuildInput> = {}): FinalizeImageBuildInput {
  return {
    buildId: BUILD_ID,
    providerSessionId: SOURCE_ID,
    correlation,
    operation: null,
    reserveOperation: vi.fn(async (_ref: string, _deadlineAt: number) => true),
    ...overrides,
  };
}

describe("DaytonaImageBuildAdapter start", () => {
  it("passes the resolved plan through, with the clone token only when one was brokered", async () => {
    const provider = createProvider();
    const bindProviderSession = vi.fn(async () => undefined);

    await createAdapter(provider).startBuild(plan(), { bindProviderSession });

    expect(provider.triggerImageBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: BUILD_ID,
        scopeKind: "repo",
        scopeId: "acme/web",
        cloneToken: "clone-1",
        buildExecutionTimeoutSeconds: 1800,
        // The provider session outlives the execution budget so finalization
        // still has a sandbox to capture.
        providerSessionTimeoutSeconds: 2400,
        onProviderSessionCreated: bindProviderSession,
      })
    );

    await createAdapter(provider).startBuild(plan({ cloneAuth: { type: "unavailable" } }), {
      bindProviderSession,
    });
    expect(provider.triggerImageBuild.mock.calls[1][0]).toMatchObject({ cloneToken: undefined });
  });
});

describe("DaytonaImageBuildAdapter capture", () => {
  it("reserves the capture's name before submitting it", async () => {
    const provider = createProvider();
    const order: string[] = [];
    provider.captureBuildSnapshot.mockImplementation(async () => {
      order.push("capture");
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => {
      order.push("reserve");
      return true;
    });

    const image = await createAdapter(provider).finalizeSuccessfulBuild(
      finalizeInput({ reserveOperation })
    );

    expect(order).toEqual(["reserve", "capture"]);
    expect(image).toEqual({ providerImageId: "snapshot-1", providerSessionId: SOURCE_ID });
    // The reserved name is derived from the build id alone, so a later
    // delivery can reconcile it without any record of this call.
    expect(reserveOperation.mock.calls[0][0]).toMatch(/^oi-image-[0-9a-f]{24}$/);
    expect(provider.captureBuildSnapshot).toHaveBeenCalledWith(
      SOURCE_ID,
      reserveOperation.mock.calls[0][0],
      undefined
    );
  });

  it("bounds the capture by the source's own expiry", async () => {
    const expiresAt = Date.now() + 5 * 60_000;
    const provider = createProvider({
      getBuildSandbox: vi.fn(async () => ({
        id: SOURCE_ID,
        state: "stopped",
        labels: { openinspect_expires_at: String(expiresAt) },
      })),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    await createAdapter(provider).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }));

    // Headroom before the source disappears, so the operation is abandoned
    // while there is still time to clean up after it.
    expect(reserveOperation.mock.calls[0][1]).toBe(expiresAt - 60_000);
  });

  it("reserves nothing for a source with no lifetime left to capture from", async () => {
    const provider = createProvider({
      getBuildSandbox: vi.fn(async () => ({
        id: SOURCE_ID,
        state: "stopped",
        labels: { openinspect_expires_at: String(Date.now() + 30_000) },
      })),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    // The headroom already puts the deadline in the past: submitting would
    // ask for a capture and give up on it in the same pass, leaving an
    // obligation nothing can settle until the source's lifetime is up.
    await expect(
      createAdapter(provider).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }))
    ).rejects.toThrow(/expires before its capture/);
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(provider.captureBuildSnapshot).not.toHaveBeenCalled();
  });

  it("waits for a source that has not finished stopping, capturing nothing", async () => {
    const provider = createProvider({
      stopBuildSandboxForCapture: vi.fn(async () => "stopping"),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    await expect(
      createAdapter(provider).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }))
    ).rejects.toMatchObject({ outcome: "pending" });
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(provider.captureBuildSnapshot).not.toHaveBeenCalled();
  });

  it("submits nothing when another delivery holds the reservation", async () => {
    const provider = createProvider();

    await expect(
      createAdapter(provider).finalizeSuccessfulBuild(
        finalizeInput({
          reserveOperation: vi.fn(async (_ref: string, _deadlineAt: number) => false),
        })
      )
    ).rejects.toMatchObject({ outcome: "pending" });
    expect(provider.captureBuildSnapshot).not.toHaveBeenCalled();
  });

  it("only reconciles a recorded operation, never stopping or capturing again", async () => {
    const provider = createProvider();
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    const image = await createAdapter(provider).finalizeSuccessfulBuild(
      finalizeInput({
        operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 60_000 },
        reserveOperation,
      })
    );

    expect(image.providerImageId).toBe("snapshot-1");
    expect(provider.stopBuildSandboxForCapture).not.toHaveBeenCalled();
    expect(provider.captureBuildSnapshot).not.toHaveBeenCalled();
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(provider.getBuildSnapshot).toHaveBeenCalledWith("oi-image-abc", undefined);
  });

  it("keeps polling a snapshot record that is not published yet", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      provider.getBuildSnapshot
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "snapshot-1",
          name: "oi-image-abc",
          state: "pending",
          sourceSandboxId: SOURCE_ID,
        })
        .mockResolvedValue({
          id: "snapshot-1",
          name: "oi-image-abc",
          state: "active",
          sourceSandboxId: SOURCE_ID,
        });

      const finalizing = createAdapter(provider).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(finalizing).resolves.toMatchObject({ providerImageId: "snapshot-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a still-unpublished capture as pending when the attempt runs out", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider({ getBuildSnapshot: vi.fn(async () => null) });

      const finalizing = createAdapter(provider).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
      );
      const outcome = finalizing.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(await outcome).toMatchObject({
        name: "ImageBuildFinalizationAttemptError",
        outcome: "pending",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up once the operation's own deadline has passed", async () => {
    const provider = createProvider({ getBuildSnapshot: vi.fn(async () => null) });

    await expect(
      createAdapter(provider).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() - 1 } })
      )
    ).rejects.toMatchObject({
      name: "ImageBuildFinalizationAttemptError",
      outcome: "ambiguous",
    });
  });

  it.each(["error", "build_failed", "removing"])(
    "fails a capture that ended as %s rather than waiting it out",
    async (state) => {
      const provider = createProvider({
        getBuildSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state,
          sourceSandboxId: SOURCE_ID,
        })),
      });

      const error = await createAdapter(provider)
        .finalizeSuccessfulBuild(
          finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
        )
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ImageBuildFinalizationAttemptError);
    }
  );

  it("refuses a snapshot under its reserved name that another sandbox produced", async () => {
    const provider = createProvider({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "active",
        sourceSandboxId: "someone-elses-sandbox",
      })),
    });

    await expect(
      createAdapter(provider).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
      )
    ).rejects.toThrow(/another source/);
  });

  it("fails a build whose source is already gone", async () => {
    const provider = createProvider({ getBuildSandbox: vi.fn(async () => null) });

    await expect(createAdapter(provider).finalizeSuccessfulBuild(finalizeInput())).rejects.toThrow(
      /no longer exists/
    );
    expect(provider.stopBuildSandboxForCapture).not.toHaveBeenCalled();
  });
});

describe("DaytonaImageBuildAdapter cleanup", () => {
  it("deletes the exact source of the build it is tearing down", async () => {
    const provider = createProvider();
    const adapter = createAdapter(provider);
    const signal = new AbortController().signal;

    await adapter.cleanupCompletedBuild({
      buildId: BUILD_ID,
      providerSessionId: SOURCE_ID,
      correlation,
      signal,
    });
    await adapter.cleanupFailedBuild({
      buildId: BUILD_ID,
      providerSessionId: SOURCE_ID,
      errorMessage: "setup failed",
      correlation,
      signal,
    });

    expect(provider.deleteBuildSandbox).toHaveBeenNthCalledWith(1, SOURCE_ID, BUILD_ID, signal);
    expect(provider.deleteBuildSandbox).toHaveBeenNthCalledWith(2, SOURCE_ID, BUILD_ID, signal);
  });

  it("deletes a captured snapshot by its artifact id", async () => {
    const provider = createProvider();

    await createAdapter(provider).deleteImage({
      image: { providerImageId: "snapshot-1", providerSessionId: SOURCE_ID },
      correlation,
    });

    expect(provider.deleteProviderImage).toHaveBeenCalledWith("snapshot-1", undefined);
  });

  it("recovers a source by its reserved name", async () => {
    const provider = createProvider({
      findBuildSandboxByName: vi.fn(async () => ({ id: SOURCE_ID, state: "started" })),
    });

    await expect(
      createAdapter(provider).recoverUnboundSource({ buildId: BUILD_ID, correlation })
    ).resolves.toEqual({ providerSessionId: SOURCE_ID });

    const missing = createProvider();
    await expect(
      createAdapter(missing).recoverUnboundSource({ buildId: BUILD_ID, correlation })
    ).resolves.toBeNull();
  });
});

describe("DaytonaImageBuildAdapter orphan operations", () => {
  const orphan = {
    buildId: BUILD_ID,
    operationRef: "oi-image-abc",
    providerSessionId: SOURCE_ID,
    correlation,
  };

  it("settles an operation that produced nothing", async () => {
    const provider = createProvider({ getBuildSnapshot: vi.fn(async () => null) });

    await expect(createAdapter(provider).reconcileOrphanOperation(orphan)).resolves.toEqual({
      type: "absent",
    });
    expect(provider.deleteProviderImage).not.toHaveBeenCalled();
  });

  it("leaves a snapshot another sandbox produced alone", async () => {
    const provider = createProvider({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "active",
        sourceSandboxId: "someone-elses-sandbox",
      })),
    });

    await expect(createAdapter(provider).reconcileOrphanOperation(orphan)).resolves.toEqual({
      type: "absent",
    });
    expect(provider.deleteProviderImage).not.toHaveBeenCalled();
  });

  it.each(["active", "inactive", "error", "build_failed"])(
    "reclaims a %s artifact the build no longer has a use for",
    async (state) => {
      const provider = createProvider({
        getBuildSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state,
          sourceSandboxId: SOURCE_ID,
        })),
      });

      await expect(createAdapter(provider).reconcileOrphanOperation(orphan)).resolves.toEqual({
        type: "deleted",
      });
      expect(provider.deleteProviderImage).toHaveBeenCalledWith("snapshot-1", undefined);
    }
  );

  it.each(["removing", "building", "pulling"])(
    "keeps an obligation whose artifact is still %s",
    async (state) => {
      const provider = createProvider({
        getBuildSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state,
          sourceSandboxId: SOURCE_ID,
        })),
      });

      await expect(createAdapter(provider).reconcileOrphanOperation(orphan)).resolves.toEqual({
        type: "pending",
      });
      expect(provider.deleteProviderImage).not.toHaveBeenCalled();
    }
  );
});
