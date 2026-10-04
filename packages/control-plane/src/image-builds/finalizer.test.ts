import { describe, expect, it, vi } from "vitest";
import type { ImageBuildFinalizationRow } from "../db/image-build-finalization";
import type { ImageBuildStore } from "../db/image-builds";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import type { FinalizeImageBuildInput } from "./types";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import {
  IMAGE_BUILD_FINALIZATION_RETRY_DELAY_MS,
  IMAGE_BUILD_PENDING_OPERATION_RETRY_DELAY_MS,
  IMAGE_BUILD_PROVIDER_ATTEMPT_MS,
  ImageBuildFinalizer,
} from "./finalizer";

const job = { version: 1 as const, buildId: "build-1", completionHash: "a".repeat(64) };
const correlation = { request_id: "queue-1", trace_id: "queue-1" };

function row(overrides: Partial<ImageBuildFinalizationRow> = {}): ImageBuildFinalizationRow {
  return {
    id: "build-1",
    provider: "modal",
    status: "building",
    provider_image_id: null,
    provider_session_id: "session-1",
    completion_hash: job.completionHash,
    repository_shas: JSON.stringify([{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }]),
    runtime_version: "v53-runtime",
    build_duration_seconds: 12.5,
    error_message: null,
    finalization_lease_token: null,
    finalization_lease_expires_at: null,
    provider_session_cleanup_pending: 1,
    callback_token_used_at: 100,
    provider_operation_ref: null,
    provider_operation_deadline_at: null,
    created_at: 1_000,
    ...overrides,
  };
}

function harness(initial = row()) {
  let current = initial;
  const finalization = {
    getBuild: vi.fn(async () => current),
    claimLease: vi.fn(async (_params: { leaseToken: string; expiresAt: number }) => true),
    clearLease: vi.fn(async () => true),
    recordArtifact: vi.fn(async ({ providerImageId }) => {
      current = { ...current, provider_image_id: providerImageId };
      return true;
    }),
    markFailed: vi.fn(async ({ error }) => {
      current = { ...current, status: "failed", error_message: error };
      return true;
    }),
    quarantineArtifact: vi.fn(async ({ providerImageId, error }) => {
      current = {
        ...current,
        status: current.status === "building" ? "failed" : current.status,
        provider_image_id: providerImageId,
        error_message: current.status === "building" ? error : current.error_message,
        finalization_lease_token: null,
        finalization_lease_expires_at: null,
      };
      return true;
    }),
    clearSessionCleanup: vi.fn(async () => {
      current = { ...current, provider_session_cleanup_pending: 0 };
      return true;
    }),
    reserveProviderOperation: vi.fn(async ({ ref, deadlineAt }) => {
      if (current.provider_operation_ref !== null) return false;
      current = {
        ...current,
        provider_operation_ref: ref,
        provider_operation_deadline_at: deadlineAt,
      };
      return true;
    }),
  };
  const store = {
    finalization,
    tryMarkImageBuildReady: vi.fn(async () => {
      current = { ...current, status: "ready" };
      return { type: "marked_ready" as const, supersededImages: [] };
    }),
    deleteSupersededImage: vi.fn(),
  };
  finalization.claimLease.mockImplementation(async ({ leaseToken, expiresAt }) => {
    current = {
      ...current,
      finalization_lease_token: leaseToken,
      finalization_lease_expires_at: expiresAt,
    };
    return true;
  });
  const adapter = {
    startBuild: vi.fn(),
    deleteImage: vi.fn(async () => undefined),
    finalizeSuccessfulBuild: vi.fn(async (_input: FinalizeImageBuildInput) => ({
      providerImageId: "image-1",
      providerSessionId: "session-1",
    })),
    cleanupCompletedBuild: vi.fn(async () => undefined),
    cleanupFailedBuild: vi.fn(async () => undefined),
  };
  const factory = { create: vi.fn(() => adapter) };
  const finalizer = new ImageBuildFinalizer(
    store as unknown as ImageBuildStore,
    factory as unknown as ImageBuildAdapterFactory,
    () => 1_000
  );
  return { finalizer, store, finalization, adapter, factory };
}

describe("ImageBuildFinalizer", () => {
  it("acknowledges a job that was delivered before acceptance", async () => {
    const { finalizer, finalization, factory } = harness(
      row({ completion_hash: null, callback_token_used_at: null })
    );

    await expect(finalizer.process(job, correlation)).resolves.toEqual({ type: "completed" });
    expect(finalization.claimLease).not.toHaveBeenCalled();
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("acknowledges a job that no longer matches the accepted completion", async () => {
    const { finalizer, finalization, factory } = harness(
      row({ completion_hash: "b".repeat(64), callback_token_used_at: 100 })
    );

    await expect(finalizer.process(job, correlation)).resolves.toEqual({ type: "completed" });
    expect(finalization.claimLease).not.toHaveBeenCalled();
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("retries after the owning lease expires when another delivery owns it", async () => {
    const { finalizer, finalization, factory } = harness(
      row({
        finalization_lease_token: "crashed-consumer",
        finalization_lease_expires_at: 361_000,
      })
    );
    finalization.claimLease.mockResolvedValue(false);

    await expect(finalizer.process(job, correlation)).resolves.toEqual({
      type: "retry",
      delayMs: 365_000,
    });
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("resumes a persisted artifact without snapshotting again", async () => {
    const { finalizer, adapter } = harness(row({ provider_image_id: "image-existing" }));

    await expect(finalizer.process(job, correlation)).resolves.toEqual({ type: "completed" });
    expect(adapter.finalizeSuccessfulBuild).not.toHaveBeenCalled();
    expect(adapter.cleanupCompletedBuild).toHaveBeenCalledOnce();
  });

  it("terminalizes invalid persisted repository provenance", async () => {
    const { finalizer, finalization, adapter, store } = harness(
      row({
        provider_image_id: "image-existing",
        repository_shas: "{invalid",
      })
    );

    await expect(finalizer.process(job, correlation)).resolves.toEqual({ type: "completed" });
    expect(finalization.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: "build-1",
        error: "Stored repository_shas is invalid",
      })
    );
    expect(store.tryMarkImageBuildReady).not.toHaveBeenCalled();
    expect(adapter.cleanupCompletedBuild).toHaveBeenCalledOnce();
  });

  it("terminalizes an expired artifact-free attempt without snapshotting again", async () => {
    const { finalizer, finalization, adapter } = harness(
      row({
        finalization_lease_token: "crashed-consumer",
        finalization_lease_expires_at: 999,
      })
    );

    await expect(finalizer.process(job, correlation)).resolves.toEqual({ type: "completed" });
    expect(adapter.finalizeSuccessfulBuild).not.toHaveBeenCalled();
    expect(finalization.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("outcome unknown"),
      })
    );
    expect(adapter.cleanupFailedBuild).toHaveBeenCalledOnce();
  });

  it("releases the lease only when the provider proves no artifact was created", async () => {
    const { finalizer, finalization, adapter } = harness();
    adapter.finalizeSuccessfulBuild.mockRejectedValue(
      new ImageBuildFinalizationAttemptError(
        "provider rejected the request before starting",
        "definitely_not_created"
      )
    );

    await expect(finalizer.process(job, correlation)).resolves.toEqual({
      type: "retry",
      delayMs: 15_000,
    });
    expect(finalization.clearLease).toHaveBeenCalledOnce();
    expect(finalization.markFailed).not.toHaveBeenCalled();
  });

  it("fails an ambiguous provider-attempt timeout without attempting a second snapshot", async () => {
    vi.useFakeTimers();
    try {
      const { finalizer, finalization, adapter } = harness();
      adapter.finalizeSuccessfulBuild.mockImplementation(
        async ({ signal }: FinalizeImageBuildInput) =>
          new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("operation aborted")));
          })
      );

      const processing = finalizer.process(job, correlation);
      await vi.advanceTimersByTimeAsync(IMAGE_BUILD_PROVIDER_ATTEMPT_MS);

      await expect(processing).resolves.toEqual({ type: "completed" });
      expect(finalization.clearLease).not.toHaveBeenCalled();
      expect(finalization.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("outcome unknown"),
        })
      );
      expect(adapter.cleanupFailedBuild).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a newly-created artifact when its fenced persistence fails", async () => {
    const { finalizer, finalization, adapter } = harness();
    finalization.recordArtifact.mockRejectedValue(new Error("D1 unavailable"));

    await expect(finalizer.process(job, correlation)).resolves.toEqual({
      type: "retry",
      delayMs: 15_000,
    });
    expect(adapter.deleteImage).toHaveBeenCalledWith({
      image: { providerImageId: "image-1", providerSessionId: "session-1" },
      correlation,
    });
    expect(finalization.clearLease).toHaveBeenCalledOnce();
  });

  it("keeps an artifact when D1 commits the record but loses the write response", async () => {
    const { finalizer, finalization, adapter, store } = harness();
    finalization.recordArtifact.mockImplementation(async ({ providerImageId }) => {
      // Model an ambiguous transport failure after D1 committed the update.
      const current = await finalization.getBuild();
      if (!current) throw new Error("missing build");
      Object.assign(current, { provider_image_id: providerImageId });
      throw new Error("D1 response lost");
    });

    await expect(finalizer.process(job, correlation)).resolves.toEqual({ type: "completed" });

    expect(adapter.deleteImage).not.toHaveBeenCalled();
    expect(store.tryMarkImageBuildReady).toHaveBeenCalledWith(
      "build-1",
      "modal",
      "image-1",
      expect.any(Array),
      "v53-runtime",
      12.5,
      expect.any(String)
    );
  });

  it("quarantines an unrecorded artifact when compensating deletion fails", async () => {
    const { finalizer, finalization, adapter } = harness();
    finalization.recordArtifact.mockResolvedValue(false);
    adapter.deleteImage.mockRejectedValue(new Error("provider delete unavailable"));

    await expect(finalizer.process(job, correlation)).resolves.toEqual({ type: "completed" });

    expect(finalization.quarantineArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: "build-1",
        providerImageId: "image-1",
      })
    );
    expect(finalization.markFailed).not.toHaveBeenCalled();
  });
});

describe("ImageBuildFinalizer asynchronous provider operations", () => {
  it("releases the lease and polls again while the provider's operation settles", async () => {
    const { finalizer, finalization, adapter } = harness(
      row({ provider_operation_ref: "oi-image-abc", provider_operation_deadline_at: 900_000 })
    );
    adapter.finalizeSuccessfulBuild.mockRejectedValue(
      new ImageBuildFinalizationAttemptError("snapshot still snapshotting", "pending")
    );

    await expect(finalizer.process(job, correlation)).resolves.toEqual({
      type: "retry",
      delayMs: IMAGE_BUILD_PENDING_OPERATION_RETRY_DELAY_MS,
      reason: "pending_operation",
    });
    expect(finalization.clearLease).toHaveBeenCalledOnce();
    expect(finalization.markFailed).not.toHaveBeenCalled();
    expect(adapter.cleanupFailedBuild).not.toHaveBeenCalled();
  });

  it("spends the host's ordinary budget on a pending attempt that reserved nothing", async () => {
    const { finalizer, finalization, adapter } = harness();
    adapter.finalizeSuccessfulBuild.mockRejectedValue(
      new ImageBuildFinalizationAttemptError("build sandbox is still stopping", "pending")
    );

    // No reservation means no fixed deadline, so this retry must not be the
    // one the consumer republishes with a fresh delivery budget.
    await expect(finalizer.process(job, correlation)).resolves.toEqual({
      type: "retry",
      delayMs: IMAGE_BUILD_FINALIZATION_RETRY_DELAY_MS,
    });
    expect(finalization.clearLease).toHaveBeenCalledOnce();
    expect(finalization.markFailed).not.toHaveBeenCalled();
  });

  it("hands the adapter the operation a previous delivery reserved", async () => {
    const { finalizer, adapter } = harness(
      row({ provider_operation_ref: "oi-image-abc", provider_operation_deadline_at: 900_000 })
    );

    await finalizer.process(job, correlation);

    expect(adapter.finalizeSuccessfulBuild).toHaveBeenCalledWith(
      expect.objectContaining({ operation: { ref: "oi-image-abc", deadlineAt: 900_000 } })
    );
  });

  it("reconciles an expired attempt that left an operation instead of failing the build", async () => {
    const { finalizer, finalization, adapter } = harness(
      row({
        finalization_lease_token: "crashed-consumer",
        finalization_lease_expires_at: 999,
        provider_operation_ref: "oi-image-abc",
        provider_operation_deadline_at: 900_000,
      })
    );

    await expect(finalizer.process(job, correlation)).resolves.toEqual({ type: "completed" });
    expect(adapter.finalizeSuccessfulBuild).toHaveBeenCalledOnce();
    expect(finalization.markFailed).not.toHaveBeenCalled();
  });

  it("fences the reservation on the lease, completion and session it was taken under", async () => {
    const { finalizer, finalization, adapter } = harness();
    adapter.finalizeSuccessfulBuild.mockImplementation(
      async ({ reserveOperation, providerSessionId }: FinalizeImageBuildInput) => {
        expect(await reserveOperation("oi-image-abc", 900_000)).toBe(true);
        return { providerImageId: "image-1", providerSessionId };
      }
    );

    await finalizer.process(job, correlation);

    expect(finalization.reserveProviderOperation).toHaveBeenCalledWith({
      buildId: "build-1",
      provider: "modal",
      providerSessionId: "session-1",
      completionHash: job.completionHash,
      leaseToken: expect.any(String),
      ref: "oi-image-abc",
      deadlineAt: 900_000,
    });
    expect(finalization.reserveProviderOperation.mock.calls[0][0].leaseToken).toBe(
      finalization.claimLease.mock.calls[0][0].leaseToken
    );
  });

  it("treats a timeout after a reservation as pending, never as an unknown outcome", async () => {
    vi.useFakeTimers();
    try {
      const { finalizer, finalization, adapter } = harness();
      adapter.finalizeSuccessfulBuild.mockImplementation(
        async ({ signal, reserveOperation }: FinalizeImageBuildInput) => {
          await reserveOperation("oi-image-abc", 900_000);
          return new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("operation aborted")));
          });
        }
      );

      const processing = finalizer.process(job, correlation);
      await vi.advanceTimersByTimeAsync(IMAGE_BUILD_PROVIDER_ATTEMPT_MS);

      await expect(processing).resolves.toEqual({
        type: "retry",
        delayMs: IMAGE_BUILD_PENDING_OPERATION_RETRY_DELAY_MS,
        reason: "pending_operation",
      });
      expect(finalization.markFailed).not.toHaveBeenCalled();
      expect(finalization.clearLease).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never re-enters the provider once an artifact is fenced on the row", async () => {
    const { finalizer, adapter, store } = harness(
      row({ provider_image_id: "image-1", provider_operation_ref: null })
    );

    await expect(finalizer.process(job, correlation)).resolves.toEqual({ type: "completed" });
    expect(adapter.finalizeSuccessfulBuild).not.toHaveBeenCalled();
    expect(store.tryMarkImageBuildReady).toHaveBeenCalledOnce();
  });
});
