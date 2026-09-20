import { describe, expect, it, vi } from "vitest";
import {
  DaytonaApiError,
  type DaytonaSandboxResponse,
  type DaytonaSnapshotResponse,
} from "../sandbox/daytona-rest-client";
import type { ImageBuildProviderTriggerConfig } from "../sandbox/provider";
import type { DaytonaImageBuildResources } from "./daytona-build-resources";
import { DaytonaImageBuildAdapter } from "./daytona-adapter";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import type { ImageBuildPlan, FinalizeImageBuildInput } from "./types";

const BUILD_ID = "imgb-acme-web-1757000000000-ab12";
const SOURCE_ID = "sandbox-abc123";
const correlation = { request_id: "request-1", trace_id: "trace-1" };

function baseResources() {
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

type ResourcesMock = ReturnType<typeof baseResources>;

function createResources(overrides: Partial<ResourcesMock> = {}): ResourcesMock {
  return { ...baseResources(), ...overrides };
}

function createAdapter(resources: ResourcesMock) {
  return new DaytonaImageBuildAdapter(resources as unknown as DaytonaImageBuildResources);
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
    const resources = createResources();
    const bindProviderSession = vi.fn(async () => undefined);

    await createAdapter(resources).startBuild(plan(), { bindProviderSession });

    expect(resources.triggerImageBuild).toHaveBeenCalledWith(
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

    await createAdapter(resources).startBuild(plan({ cloneAuth: { type: "unavailable" } }), {
      bindProviderSession,
    });
    expect(resources.triggerImageBuild.mock.calls[1][0]).toMatchObject({ cloneToken: undefined });
  });
});

describe("DaytonaImageBuildAdapter capture", () => {
  it.each([
    ["HTTP 429", () => new DaytonaApiError("rate limited", 429)],
    ["HTTP 502", () => new DaytonaApiError("bad gateway", 502)],
    ["a request timeout", () => new DOMException("The operation was aborted", "AbortError")],
    ["a network failure", () => new TypeError("fetch failed")],
  ])("retries when the initial source read hits %s", async (_name, failure) => {
    const resources = createResources({
      getBuildSandbox: vi.fn(async () => {
        throw failure();
      }),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }))
    ).rejects.toMatchObject({ outcome: "definitely_not_created" });

    expect(resources.stopBuildSandboxForCapture).not.toHaveBeenCalled();
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(resources.captureBuildSnapshot).not.toHaveBeenCalled();
  });

  it("fails a permanent initial source-read error", async () => {
    const resources = createResources({
      getBuildSandbox: vi.fn(async () => {
        throw new DaytonaApiError("unauthorized", 401);
      }),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())
    ).rejects.toMatchObject({ status: 401 });
    expect(resources.stopBuildSandboxForCapture).not.toHaveBeenCalled();
    expect(resources.captureBuildSnapshot).not.toHaveBeenCalled();
  });

  it("reserves the capture's name before submitting it", async () => {
    const resources = createResources();
    const order: string[] = [];
    resources.captureBuildSnapshot.mockImplementation(async () => {
      order.push("capture");
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => {
      order.push("reserve");
      return true;
    });

    const image = await createAdapter(resources).finalizeSuccessfulBuild(
      finalizeInput({ reserveOperation })
    );

    expect(order).toEqual(["reserve", "capture"]);
    expect(image).toEqual({ providerImageId: "snapshot-1", providerSessionId: SOURCE_ID });
    // The reserved name is derived from the build id alone, so a later
    // delivery can reconcile it without any record of this call.
    expect(reserveOperation.mock.calls[0][0]).toMatch(/^oi-image-[0-9a-f]{24}$/);
    expect(resources.captureBuildSnapshot).toHaveBeenCalledWith(
      SOURCE_ID,
      reserveOperation.mock.calls[0][0],
      undefined
    );
  });

  it("bounds the capture by the source's own expiry", async () => {
    const expiresAt = Date.now() + 5 * 60_000;
    const resources = createResources({
      getBuildSandbox: vi.fn(async () => ({
        id: SOURCE_ID,
        state: "stopped",
        labels: { openinspect_expires_at: String(expiresAt) },
      })),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    await createAdapter(resources).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }));

    // Headroom before the source disappears, so the operation is abandoned
    // while there is still time to clean up after it.
    expect(reserveOperation.mock.calls[0][1]).toBe(expiresAt - 60_000);
  });

  it("reserves nothing for a source with no lifetime left to capture from", async () => {
    const resources = createResources({
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
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }))
    ).rejects.toThrow(/expires before its capture/);
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(resources.captureBuildSnapshot).not.toHaveBeenCalled();
  });

  it("waits for a source that has not finished stopping, capturing nothing", async () => {
    const resources = createResources({
      stopBuildSandboxForCapture: vi.fn(async () => "stopping"),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }))
    ).rejects.toMatchObject({ outcome: "pending" });
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(resources.captureBuildSnapshot).not.toHaveBeenCalled();
  });

  it("submits nothing when another delivery holds the reservation", async () => {
    const resources = createResources();

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({
          reserveOperation: vi.fn(async (_ref: string, _deadlineAt: number) => false),
        })
      )
    ).rejects.toMatchObject({ outcome: "pending" });
    expect(resources.captureBuildSnapshot).not.toHaveBeenCalled();
  });

  it("only reconciles a recorded operation, never stopping or capturing again", async () => {
    const resources = createResources();
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    const image = await createAdapter(resources).finalizeSuccessfulBuild(
      finalizeInput({
        operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 60_000 },
        reserveOperation,
      })
    );

    expect(image.providerImageId).toBe("snapshot-1");
    expect(resources.stopBuildSandboxForCapture).not.toHaveBeenCalled();
    expect(resources.captureBuildSnapshot).not.toHaveBeenCalled();
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(resources.getBuildSnapshot).toHaveBeenCalledWith("oi-image-abc", undefined);
  });

  it.each([
    ["HTTP 503", () => new DaytonaApiError("service unavailable", 503)],
    ["a request timeout", () => new DOMException("The operation was aborted", "AbortError")],
    ["a network failure", () => new TypeError("fetch failed")],
  ])("reconciles its reserved name after capture submission hits %s", async (_name, failure) => {
    const resources = createResources({
      captureBuildSnapshot: vi.fn(async () => {
        throw failure();
      }),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }))
    ).resolves.toEqual({ providerImageId: "snapshot-1", providerSessionId: SOURCE_ID });

    expect(reserveOperation).toHaveBeenCalledOnce();
    expect(resources.captureBuildSnapshot).toHaveBeenCalledOnce();
    expect(resources.getBuildSnapshot).toHaveBeenCalledWith(
      reserveOperation.mock.calls[0][0],
      undefined
    );
  });

  it.each([400, 429])(
    "fails a provider-confirmed capture-submission rejection (%s) without adopting an artifact",
    async (status) => {
      const resources = createResources({
        captureBuildSnapshot: vi.fn(async () => {
          throw new DaytonaApiError("capture request rejected", status);
        }),
      });

      await expect(
        createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())
      ).rejects.toMatchObject({ status });
      expect(resources.getBuildSnapshot).not.toHaveBeenCalled();
    }
  );

  // Both completed states settle the build. An inactive snapshot is cold
  // storage the spawn path activates under its own budget, so finalization
  // records it rather than polling it to the operation's deadline.
  it.each(["active", "inactive"])("completes a build whose capture is %s", async (state) => {
    const resources = createResources({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state,
        sourceSandboxId: SOURCE_ID,
      })),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
      )
    ).resolves.toEqual({ providerImageId: "snapshot-1", providerSessionId: SOURCE_ID });
    // Activation belongs to the consumer, which has its own budget for it.
    expect(resources.getBuildSnapshot).toHaveBeenCalledTimes(1);
  });

  it("refuses an inactive snapshot under its reserved name from another source", async () => {
    const resources = createResources({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "inactive",
        sourceSandboxId: "someone-elses-sandbox",
      })),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
      )
    ).rejects.toThrow(/another source/);
  });

  it("completes a first-delivery capture that settles inactive", async () => {
    const resources = createResources({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "inactive",
        sourceSandboxId: SOURCE_ID,
      })),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())
    ).resolves.toEqual({ providerImageId: "snapshot-1", providerSessionId: SOURCE_ID });
    expect(resources.captureBuildSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps polling a snapshot record that is not published yet", async () => {
    vi.useFakeTimers();
    try {
      const resources = createResources();
      resources.getBuildSnapshot
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

      const finalizing = createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(finalizing).resolves.toMatchObject({ providerImageId: "snapshot-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["HTTP 429", () => new DaytonaApiError("rate limited", 429)],
    ["HTTP 503", () => new DaytonaApiError("service unavailable", 503)],
    ["a request timeout", () => new DOMException("The operation was aborted", "AbortError")],
    ["a network failure", () => new TypeError("fetch failed")],
  ])("keeps reconciling after a snapshot read hits %s", async (_name, failure) => {
    vi.useFakeTimers();
    try {
      const resources = createResources();
      resources.getBuildSnapshot.mockRejectedValueOnce(failure()).mockResolvedValue({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "active",
        sourceSandboxId: SOURCE_ID,
      });

      const finalizing = createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(finalizing).resolves.toEqual({
        providerImageId: "snapshot-1",
        providerSessionId: SOURCE_ID,
      });
      expect(resources.getBuildSnapshot).toHaveBeenCalledTimes(2);
      expect(resources.captureBuildSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the fixed operation deadline across repeated transient read failures", async () => {
    vi.useFakeTimers();
    try {
      const resources = createResources({
        getBuildSnapshot: vi.fn(async () => {
          throw new DaytonaApiError("service unavailable", 503);
        }),
      });
      const deadlineAt = Date.now() + 6_000;

      const outcome = createAdapter(resources)
        .finalizeSuccessfulBuild(finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt } }))
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await outcome).toMatchObject({
        name: "ImageBuildFinalizationAttemptError",
        outcome: "ambiguous",
      });
      expect(Date.now()).toBeGreaterThanOrEqual(deadlineAt);
      expect(resources.captureBuildSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a permanent snapshot-read error instead of waiting it out", async () => {
    const resources = createResources({
      getBuildSnapshot: vi.fn(async () => {
        throw new DaytonaApiError("unauthorized", 401);
      }),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
      )
    ).rejects.toMatchObject({ status: 401 });
    expect(resources.getBuildSnapshot).toHaveBeenCalledOnce();
  });

  it("reports a still-unpublished capture as pending when the attempt runs out", async () => {
    vi.useFakeTimers();
    try {
      const resources = createResources({ getBuildSnapshot: vi.fn(async () => null) });

      const finalizing = createAdapter(resources).finalizeSuccessfulBuild(
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
    const resources = createResources({ getBuildSnapshot: vi.fn(async () => null) });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
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
      const resources = createResources({
        getBuildSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state,
          sourceSandboxId: SOURCE_ID,
        })),
      });

      const error = await createAdapter(resources)
        .finalizeSuccessfulBuild(
          finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
        )
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ImageBuildFinalizationAttemptError);
    }
  );

  it("refuses a snapshot under its reserved name that another sandbox produced", async () => {
    const resources = createResources({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "active",
        sourceSandboxId: "someone-elses-sandbox",
      })),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
      )
    ).rejects.toThrow(/another source/);
  });

  // Finalization is the other side of the same rule: reconciliation keeps an
  // unprovable artifact, finalization refuses to adopt one. Which half applies
  // depends on whether the capture has settled.
  it.each([
    ["null", null],
    ["empty", ""],
  ])(
    "refuses to adopt a settled snapshot whose source the provider reports as %s",
    async (_label, sourceSandboxId) => {
      const resources = createResources({
        getBuildSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state: "active",
          sourceSandboxId,
        })),
      });

      await expect(
        createAdapter(resources).finalizeSuccessfulBuild(
          finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
        )
      ).rejects.toThrow(/no provable source/);
    }
  );

  it.each(["error", "build_failed", "removing"])(
    "refuses a capture that failed without ever naming a source (%s)",
    async (state) => {
      const resources = createResources({
        getBuildSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state,
          sourceSandboxId: null,
        })),
      });

      await expect(
        createAdapter(resources).finalizeSuccessfulBuild(
          finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
        )
      ).rejects.toThrow(/no provable source/);
    }
  );

  // Provenance can lag the record, so a capture still being produced without
  // one is watched rather than failed.
  it.each([
    ["null", null],
    ["empty", ""],
  ])(
    "waits out a capture whose source the provider reports as %s until it names ours",
    async (_label, sourceSandboxId) => {
      vi.useFakeTimers();
      try {
        const resources = createResources();
        resources.getBuildSnapshot
          .mockResolvedValueOnce({
            id: "snapshot-1",
            name: "oi-image-abc",
            state: "snapshotting",
            sourceSandboxId,
          })
          .mockResolvedValue({
            id: "snapshot-1",
            name: "oi-image-abc",
            state: "active",
            sourceSandboxId: SOURCE_ID,
          });

        const finalizing = createAdapter(resources).finalizeSuccessfulBuild(
          finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() + 600_000 } })
        );
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(finalizing).resolves.toEqual({
          providerImageId: "snapshot-1",
          providerSessionId: SOURCE_ID,
        });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  // Same ending as a record that never appears: the operation stays on the row
  // for maintenance to reconcile, rather than the build failing outright.
  it("gives up on a capture that never names a source, keeping the operation", async () => {
    const resources = createResources({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "snapshotting",
        sourceSandboxId: null,
      })),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: "oi-image-abc", deadlineAt: Date.now() - 1 } })
      )
    ).rejects.toMatchObject({
      name: "ImageBuildFinalizationAttemptError",
      outcome: "ambiguous",
    });
  });

  it("fails a build whose source is already gone", async () => {
    const resources = createResources({ getBuildSandbox: vi.fn(async () => null) });

    await expect(createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())).rejects.toThrow(
      /no longer exists/
    );
    expect(resources.stopBuildSandboxForCapture).not.toHaveBeenCalled();
  });
});

describe("DaytonaImageBuildAdapter cleanup", () => {
  it("deletes the exact source of the build it is tearing down", async () => {
    const resources = createResources();
    const adapter = createAdapter(resources);
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

    expect(resources.deleteBuildSandbox).toHaveBeenNthCalledWith(1, SOURCE_ID, BUILD_ID, signal);
    expect(resources.deleteBuildSandbox).toHaveBeenNthCalledWith(2, SOURCE_ID, BUILD_ID, signal);
  });

  it("deletes a captured snapshot by its artifact id", async () => {
    const resources = createResources();

    await createAdapter(resources).deleteImage({
      image: { providerImageId: "snapshot-1", providerSessionId: SOURCE_ID },
      correlation,
    });

    expect(resources.deleteProviderImage).toHaveBeenCalledWith("snapshot-1", undefined);
  });

  it("recovers a source by its reserved name", async () => {
    const resources = createResources({
      findBuildSandboxByName: vi.fn(async () => ({ id: SOURCE_ID, state: "started" })),
    });

    await expect(
      createAdapter(resources).recoverUnboundSource({ buildId: BUILD_ID, correlation })
    ).resolves.toEqual({ providerSessionId: SOURCE_ID });

    const missing = createResources();
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
    const resources = createResources({ getBuildSnapshot: vi.fn(async () => null) });

    await expect(createAdapter(resources).reconcileOrphanOperation(orphan)).resolves.toEqual({
      type: "absent",
    });
    expect(resources.deleteProviderImage).not.toHaveBeenCalled();
  });

  it("leaves a snapshot another sandbox produced alone", async () => {
    const resources = createResources({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "active",
        sourceSandboxId: "someone-elses-sandbox",
      })),
    });

    await expect(createAdapter(resources).reconcileOrphanOperation(orphan)).resolves.toEqual({
      type: "absent",
    });
    expect(resources.deleteProviderImage).not.toHaveBeenCalled();
  });

  // Settling on an ownership question nobody answered would clear the row's
  // only record of a snapshot that may be this build's, and the artifact
  // would outlive everything that knows about it.
  it("keeps an obligation whose snapshot names no source", async () => {
    const resources = createResources({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "active",
        sourceSandboxId: null,
      })),
    });

    await expect(createAdapter(resources).reconcileOrphanOperation(orphan)).resolves.toEqual({
      type: "pending",
    });
    expect(resources.deleteProviderImage).not.toHaveBeenCalled();
  });

  it("keeps an obligation whose row no longer names a source sandbox", async () => {
    const resources = createResources();

    await expect(
      createAdapter(resources).reconcileOrphanOperation({ ...orphan, providerSessionId: null })
    ).resolves.toEqual({ type: "pending" });
    expect(resources.deleteProviderImage).not.toHaveBeenCalled();
  });

  it("settles nothing on an unprovable snapshot even once it is terminal", async () => {
    const resources = createResources({
      getBuildSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "build_failed",
        sourceSandboxId: "",
      })),
    });

    await expect(createAdapter(resources).reconcileOrphanOperation(orphan)).resolves.toEqual({
      type: "pending",
    });
    expect(resources.deleteProviderImage).not.toHaveBeenCalled();
  });

  it.each(["active", "inactive", "error", "build_failed"])(
    "reclaims a %s artifact the build no longer has a use for",
    async (state) => {
      const resources = createResources({
        getBuildSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state,
          sourceSandboxId: SOURCE_ID,
        })),
      });

      await expect(createAdapter(resources).reconcileOrphanOperation(orphan)).resolves.toEqual({
        type: "deleted",
      });
      expect(resources.deleteProviderImage).toHaveBeenCalledWith("snapshot-1", undefined);
    }
  );

  it.each(["removing", "building", "pulling"])(
    "keeps an obligation whose artifact is still %s",
    async (state) => {
      const resources = createResources({
        getBuildSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state,
          sourceSandboxId: SOURCE_ID,
        })),
      });

      await expect(createAdapter(resources).reconcileOrphanOperation(orphan)).resolves.toEqual({
        type: "pending",
      });
      expect(resources.deleteProviderImage).not.toHaveBeenCalled();
    }
  );
});
