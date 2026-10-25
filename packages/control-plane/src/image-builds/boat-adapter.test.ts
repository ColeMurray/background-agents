import { describe, expect, it, vi } from "vitest";
import {
  BoatApiError,
  BoatCancelledError,
  BoatConflictError,
  type BoatSavedSnapshot,
} from "../sandbox/boat-rest-client";
import { SandboxProviderError } from "../sandbox/provider";
import { BOAT_IMAGE_SAVE_DEADLINE_MS, BoatImageBuildAdapter } from "./boat-adapter";
import type {
  BoatBuildSourceStop,
  BoatImageBuildResources,
  BoatImageBuildTriggerConfig,
} from "./boat-build-resources";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import { resolveImageBuildProviderSessionTimeoutSeconds } from "./timeouts";
import type { FinalizeImageBuildInput, ImageBuildPlan } from "./types";

const BUILD_ID = "imgb-acme-repo-1757000000000-ab12";
const SOURCE_ID = "bx_abcdefgh";
const IMAGE_NAME = `oi-img-acme-repo-1757000000000-ab12-0123456789abcdef`;
const correlation = { request_id: "request-1", trace_id: "trace-1" };

function snapshot(overrides: Partial<BoatSavedSnapshot> = {}): BoatSavedSnapshot {
  return {
    name: IMAGE_NAME,
    status: "ready",
    sourceSandboxId: SOURCE_ID,
    type: "default",
    sizeBytes: 3_907_112_960,
    createdAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseResources() {
  return {
    triggerImageBuild: vi.fn(async (_config: BoatImageBuildTriggerConfig) => undefined),
    stopBuildSandboxForSave: vi.fn(async (): Promise<BoatBuildSourceStop> => "stopped"),
    imageSnapshotName: vi.fn(async () => IMAGE_NAME),
    saveImageSnapshot: vi.fn(async (_sandboxId: string, name: string) =>
      snapshot({ name, status: "saving" })
    ),
    getImageSnapshot: vi.fn(async (): Promise<BoatSavedSnapshot | null> => snapshot()),
    deleteProviderImage: vi.fn(async () => undefined),
    deleteBuildSandbox: vi.fn(async () => undefined),
  };
}

type ResourcesMock = ReturnType<typeof baseResources>;

function createResources(overrides: Partial<ResourcesMock> = {}): ResourcesMock {
  return { ...baseResources(), ...overrides };
}

/** Polls settle within a unit test; the observation window is a few polls long. */
function createAdapter(resources: ResourcesMock) {
  return new BoatImageBuildAdapter(resources as unknown as BoatImageBuildResources, {
    saveObservationMs: 30,
    savePollIntervalMs: 1,
  });
}

function plan(overrides: Partial<ImageBuildPlan> = {}): ImageBuildPlan {
  return {
    buildId: BUILD_ID,
    scope: { kind: "repo", id: "acme/repo" },
    repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "main" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    buildTimeoutMs: 1_800_000,
    resources: { cpuCores: 2, memoryMib: 16384 },
    correlation,
    callbackToken: "a".repeat(64),
    cloneAuth: { type: "credential_helper", token: "clone-1" },
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

/** A call Boat refused, with its stable code, as the resources let it through. */
function refused(status: number, code: string) {
  return status === 409 ? new BoatConflictError(code, code) : new BoatApiError(code, status, code);
}

describe("BoatImageBuildAdapter start", () => {
  it("passes the resolved plan through, with the scope's resources and the clone token only when one was brokered", async () => {
    const resources = createResources();
    const bindProviderSession = vi.fn(async () => undefined);

    await createAdapter(resources).startBuild(plan(), { bindProviderSession });

    expect(resources.triggerImageBuild).toHaveBeenCalledWith({
      scopeKind: "repo",
      scopeId: "acme/repo",
      buildId: BUILD_ID,
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "main" }],
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      callbackToken: "a".repeat(64),
      cloneToken: "clone-1",
      buildExecutionTimeoutSeconds: 1800,
      providerSessionTimeoutSeconds: resolveImageBuildProviderSessionTimeoutSeconds(1_800_000),
      resources: { cpuCores: 2, memoryMib: 16384 },
      userEnvVars: undefined,
      onProviderSessionCreated: bindProviderSession,
      correlation,
    });

    await createAdapter(resources).startBuild(plan({ cloneAuth: { type: "unavailable" } }), {
      bindProviderSession,
    });
    expect(resources.triggerImageBuild.mock.calls[1][0]).toMatchObject({ cloneToken: undefined });
  });
});

describe("BoatImageBuildAdapter first delivery", () => {
  it("archives the source, reserves the image name, saves and returns the ready image", async () => {
    const resources = createResources({
      getImageSnapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot({ status: "saving" }))
        .mockResolvedValue(snapshot()),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);
    const signal = AbortSignal.timeout(60_000);
    const before = Date.now();

    const image = await createAdapter(resources).finalizeSuccessfulBuild(
      finalizeInput({ reserveOperation, signal })
    );

    expect(image).toEqual({ providerImageId: IMAGE_NAME, providerSessionId: SOURCE_ID });
    expect(resources.stopBuildSandboxForSave).toHaveBeenCalledWith(SOURCE_ID, signal);
    expect(reserveOperation).toHaveBeenCalledTimes(1);
    const [ref, deadlineAt] = reserveOperation.mock.calls[0];
    expect(ref).toBe(IMAGE_NAME);
    expect(deadlineAt).toBeGreaterThanOrEqual(before + BOAT_IMAGE_SAVE_DEADLINE_MS);
    expect(resources.saveImageSnapshot).toHaveBeenCalledTimes(1);
    expect(resources.saveImageSnapshot).toHaveBeenCalledWith(SOURCE_ID, IMAGE_NAME, signal);
    // The stop comes first: the saved disk is the archived one.
    expect(resources.stopBuildSandboxForSave.mock.invocationCallOrder[0]).toBeLessThan(
      resources.saveImageSnapshot.mock.invocationCallOrder[0]
    );
  });

  it("retries without reserving when the source cannot be read or stopped right now", async () => {
    const resources = createResources({
      stopBuildSandboxForSave: vi.fn(async () => {
        throw new BoatApiError("busy", 503);
      }),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }))
    ).rejects.toMatchObject({ outcome: "definitely_not_created" });

    expect(reserveOperation).not.toHaveBeenCalled();
    expect(resources.saveImageSnapshot).not.toHaveBeenCalled();
  });

  it("fails a permanent stop failure and a missing source, and waits out a slow archive", async () => {
    await expect(
      createAdapter(
        createResources({
          stopBuildSandboxForSave: vi.fn(async () => {
            throw new SandboxProviderError("archived without a usable snapshot", "permanent");
          }),
        })
      ).finalizeSuccessfulBuild(finalizeInput())
    ).rejects.toThrow("usable snapshot");

    await expect(
      createAdapter(
        createResources({ stopBuildSandboxForSave: vi.fn(async () => "missing" as const) })
      ).finalizeSuccessfulBuild(finalizeInput())
    ).rejects.toThrow("no longer exists");

    const slow = createResources({
      stopBuildSandboxForSave: vi.fn(async () => "stopping" as const),
    });
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);
    await expect(
      createAdapter(slow).finalizeSuccessfulBuild(finalizeInput({ reserveOperation }))
    ).rejects.toMatchObject({ outcome: "pending" });
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(slow.saveImageSnapshot).not.toHaveBeenCalled();
  });

  it("submits nothing when another delivery holds the reservation", async () => {
    const resources = createResources();

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ reserveOperation: vi.fn(async () => false) })
      )
    ).rejects.toMatchObject({ outcome: "pending" });

    expect(resources.saveImageSnapshot).not.toHaveBeenCalled();
    expect(resources.getImageSnapshot).not.toHaveBeenCalled();
  });

  it("treats a save already running under the name as this build's own", async () => {
    const resources = createResources({
      saveImageSnapshot: vi.fn(async () => {
        throw refused(409, "save_in_progress");
      }),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())
    ).resolves.toEqual({ providerImageId: IMAGE_NAME, providerSessionId: SOURCE_ID });
  });

  it("fails the build with an actionable reason when the account cannot keep another snapshot", async () => {
    const resources = createResources({
      saveImageSnapshot: vi.fn(async () => {
        throw refused(402, "credit_required");
      }),
    });

    await expect(createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())).rejects.toThrow(
      /saved-snapshot allowance.*add money to the Boat wallet/
    );
    expect(resources.getImageSnapshot).not.toHaveBeenCalled();
  });

  it("reconciles under the reserved name when the save request's outcome is unknown", async () => {
    const resources = createResources({
      saveImageSnapshot: vi.fn(async () => {
        throw new BoatCancelledError("POST /saved-snapshots");
      }),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())
    ).resolves.toEqual({ providerImageId: IMAGE_NAME, providerSessionId: SOURCE_ID });
    // The poll found Boat's record, so the unknown request was not repeated.
    expect(resources.saveImageSnapshot).toHaveBeenCalledTimes(1);
  });

  it("hands a save that is still running to the next delivery", async () => {
    const resources = createResources({
      getImageSnapshot: vi.fn(async () => snapshot({ status: "saving" })),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())
    ).rejects.toMatchObject({ outcome: "pending", message: expect.stringContaining("saving") });
    expect(resources.getImageSnapshot.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps polling through an unreachable provider and reports pending, not failure", async () => {
    const resources = createResources({
      getImageSnapshot: vi.fn(async () => {
        throw new BoatApiError("rate limited", 429);
      }),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())
    ).rejects.toMatchObject({ outcome: "pending" });
    expect(resources.saveImageSnapshot).toHaveBeenCalledTimes(1);
  });

  it("fails a save Boat reports failed, with Boat's reason", async () => {
    const resources = createResources({
      getImageSnapshot: vi.fn(async () => snapshot({ status: "failed", error: "disk too large" })),
    });

    const error = await createAdapter(resources)
      .finalizeSuccessfulBuild(finalizeInput())
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ImageBuildFinalizationAttemptError);
    expect((error as Error).message).toContain("disk too large");
  });

  it("refuses a ready snapshot saved from another sandbox", async () => {
    const resources = createResources({
      getImageSnapshot: vi.fn(async () => snapshot({ sourceSandboxId: "bx_someoneelse" })),
    });

    await expect(createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())).rejects.toThrow(
      "another source"
    );
  });
});

describe("BoatImageBuildAdapter recorded operation", () => {
  const operation = { ref: IMAGE_NAME, deadlineAt: Date.now() + 60_000 };

  it("only reconciles the reserved name: no stop, no reservation, no new save", async () => {
    const resources = createResources();
    const reserveOperation = vi.fn(async (_ref: string, _deadlineAt: number) => true);

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation, reserveOperation })
      )
    ).resolves.toEqual({ providerImageId: IMAGE_NAME, providerSessionId: SOURCE_ID });

    expect(resources.stopBuildSandboxForSave).not.toHaveBeenCalled();
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(resources.saveImageSnapshot).not.toHaveBeenCalled();
    expect(resources.getImageSnapshot).toHaveBeenCalledWith(IMAGE_NAME, undefined);
  });

  it("submits the save once when Boat has no record under the reserved name", async () => {
    const resources = createResources({
      getImageSnapshot: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(snapshot()),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput({ operation }))
    ).resolves.toEqual({ providerImageId: IMAGE_NAME, providerSessionId: SOURCE_ID });

    expect(resources.saveImageSnapshot).toHaveBeenCalledTimes(1);
    expect(resources.saveImageSnapshot).toHaveBeenCalledWith(SOURCE_ID, IMAGE_NAME, undefined);
  });

  it("does not submit twice in one delivery when the record stays absent", async () => {
    const resources = createResources({ getImageSnapshot: vi.fn(async () => null) });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput({ operation }))
    ).rejects.toMatchObject({ outcome: "pending" });

    expect(resources.saveImageSnapshot).toHaveBeenCalledTimes(1);
  });

  it("fails as ambiguous once the operation's fixed deadline has passed", async () => {
    const resources = createResources({
      getImageSnapshot: vi.fn(async () => snapshot({ status: "saving" })),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: IMAGE_NAME, deadlineAt: Date.now() - 1 } })
      )
    ).rejects.toMatchObject({ outcome: "ambiguous" });
  });

  it("submits nothing for an absent record once the deadline has passed", async () => {
    const resources = createResources({ getImageSnapshot: vi.fn(async () => null) });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: IMAGE_NAME, deadlineAt: Date.now() - 1 } })
      )
    ).rejects.toMatchObject({ outcome: "ambiguous" });

    expect(resources.saveImageSnapshot).not.toHaveBeenCalled();
  });

  it("still adopts a snapshot that is ready after the deadline", async () => {
    const resources = createResources();

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: IMAGE_NAME, deadlineAt: Date.now() - 1 } })
      )
    ).resolves.toEqual({ providerImageId: IMAGE_NAME, providerSessionId: SOURCE_ID });
  });
});

describe("BoatImageBuildAdapter cleanup and reclamation", () => {
  it("deletes the build sandbox after completed and failed builds, and images through the resources", async () => {
    const resources = createResources();
    const adapter = createAdapter(resources);
    const signal = AbortSignal.timeout(60_000);

    await adapter.cleanupCompletedBuild({
      buildId: BUILD_ID,
      providerSessionId: SOURCE_ID,
      correlation,
      signal,
    });
    await adapter.cleanupFailedBuild({
      buildId: BUILD_ID,
      providerSessionId: SOURCE_ID,
      errorMessage: "setup.sh failed",
      correlation,
    });
    await adapter.deleteImage({
      image: { providerImageId: IMAGE_NAME, providerSessionId: SOURCE_ID },
      correlation,
      signal,
    });

    expect(resources.deleteBuildSandbox).toHaveBeenNthCalledWith(1, SOURCE_ID, signal);
    expect(resources.deleteBuildSandbox).toHaveBeenNthCalledWith(2, SOURCE_ID, undefined);
    expect(resources.deleteProviderImage).toHaveBeenCalledWith(IMAGE_NAME, signal);
  });

  it("settles an orphaned name by what Boat holds under it", async () => {
    const input = {
      buildId: BUILD_ID,
      operationRef: IMAGE_NAME,
      providerSessionId: SOURCE_ID,
      correlation,
    };

    const absent = createResources({ getImageSnapshot: vi.fn(async () => null) });
    await expect(createAdapter(absent).reconcileOrphanOperation(input)).resolves.toEqual({
      type: "absent",
    });
    expect(absent.deleteProviderImage).not.toHaveBeenCalled();

    const saving = createResources({
      getImageSnapshot: vi.fn(async () => snapshot({ status: "saving" })),
    });
    await expect(createAdapter(saving).reconcileOrphanOperation(input)).resolves.toEqual({
      type: "pending",
    });

    const ours = createResources();
    await expect(createAdapter(ours).reconcileOrphanOperation(input)).resolves.toEqual({
      type: "deleted",
    });
    expect(ours.deleteProviderImage).toHaveBeenCalledWith(IMAGE_NAME, undefined);

    const failed = createResources({
      getImageSnapshot: vi.fn(async () => snapshot({ status: "failed", error: "boom" })),
    });
    await expect(createAdapter(failed).reconcileOrphanOperation(input)).resolves.toEqual({
      type: "deleted",
    });

    const another = createResources({
      getImageSnapshot: vi.fn(async () => snapshot({ sourceSandboxId: "bx_someoneelse" })),
    });
    await expect(createAdapter(another).reconcileOrphanOperation(input)).resolves.toEqual({
      type: "absent",
    });
    expect(another.deleteProviderImage).not.toHaveBeenCalled();

    const busy = createResources({
      deleteProviderImage: vi.fn(async () => {
        throw refused(409, "save_in_progress");
      }),
    });
    await expect(createAdapter(busy).reconcileOrphanOperation(input)).resolves.toEqual({
      type: "pending",
    });
  });

  it("reclaims a name whose row has lost its sandbox", async () => {
    const resources = createResources();
    await expect(
      createAdapter(resources).reconcileOrphanOperation({
        buildId: BUILD_ID,
        operationRef: IMAGE_NAME,
        providerSessionId: null,
        correlation,
      })
    ).resolves.toEqual({ type: "deleted" });
  });
});
