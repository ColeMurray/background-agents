import { describe, expect, it, vi } from "vitest";
import type { ImageBuildStore } from "../db/image-builds";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { DEFAULT_STALE_BUILD_MAX_AGE_MS } from "./maintenance";
import { IMAGE_BUILD_CLEANUP_ATTEMPT_MS, ImageBuildReaper } from "./reaper";

const ctx = { trace_id: "t", request_id: "r" };

function createStore() {
  return {
    getFailedImagesWithArtifacts: vi.fn().mockResolvedValue([]),
    deleteOldFailedBuilds: vi.fn().mockResolvedValue(0),
    getSupersededImages: vi.fn().mockResolvedValue([]),
    deleteSupersededImage: vi.fn().mockResolvedValue(true),
    clearFailedImageArtifact: vi.fn().mockResolvedValue(true),
    listUnboundSourceIntents: vi.fn().mockResolvedValue([]),
    listUnresolvedOperations: vi.fn().mockResolvedValue([]),
    attachRecoveredProviderSession: vi.fn().mockResolvedValue(true),
    clearUnboundSourceIntent: vi.fn().mockResolvedValue(true),
    clearProviderOperation: vi.fn().mockResolvedValue(true),
  };
}

function createAdapter() {
  return {
    deleteImage: vi.fn().mockResolvedValue(undefined),
  };
}

/** An adapter whose provider can be reconciled by reserved name. */
function createRecoverableAdapter() {
  return {
    deleteImage: vi.fn().mockResolvedValue(undefined),
    recoverUnboundSource: vi.fn().mockResolvedValue(null),
    reconcileOrphanOperation: vi.fn().mockResolvedValue({ type: "absent" as const }),
  };
}

function createReaper(options: {
  store?: ReturnType<typeof createStore>;
  adapter?: ReturnType<typeof createAdapter>;
}) {
  const store = options.store ?? createStore();
  const adapter = options.adapter ?? createAdapter();
  const factory = { create: vi.fn().mockReturnValue(adapter) };
  const reaper = new ImageBuildReaper(
    store as unknown as ImageBuildStore,
    factory as unknown as ImageBuildAdapterFactory
  );
  return { reaper, store, adapter, factory };
}

function reapableRow(id: string, providerImageId: string | null) {
  return {
    id,
    scope_kind: "environment" as const,
    scope_id: "env_1",
    provider: "modal" as const,
    provider_image_id: providerImageId,
    provider_session_id: null,
    created_at: Number(id.replace(/\D/g, "")) || 1,
  };
}

describe("ImageBuildReaper", () => {
  describe("cleanupImages", () => {
    it("deletes old failed rows and reaps superseded artifacts", async () => {
      const store = createStore();
      store.deleteOldFailedBuilds.mockResolvedValue(3);
      store.getSupersededImages.mockResolvedValue([
        reapableRow("s-artifact", "im-a"),
        reapableRow("s-bare", null),
        reapableRow("s-stuck", "im-stuck"),
      ]);
      const adapter = createAdapter();
      adapter.deleteImage.mockImplementation(async ({ image }) => {
        if (image.providerImageId === "im-stuck") throw new Error("provider 500");
      });
      const { reaper } = createReaper({ store, adapter });

      const result = await reaper.cleanupImages(86_400_000, ctx);

      // s-artifact: artifact deleted then row reaped. s-bare: no artifact, row
      // reaped directly. s-stuck: artifact delete failed, row kept for retry.
      expect(result).toEqual({ deletedFailed: 3, reapedFailed: 0, reapedSuperseded: 2 });
      expect(store.deleteSupersededImage).toHaveBeenCalledWith("s-artifact", "im-a");
      expect(store.deleteSupersededImage).toHaveBeenCalledWith("s-bare", null);
      expect(store.deleteSupersededImage).not.toHaveBeenCalledWith("s-stuck", "im-stuck");
    });

    it("reaps a restore-failed row's artifact then clears its columns, keeping it failed", async () => {
      const store = createStore();
      store.getFailedImagesWithArtifacts.mockResolvedValue([
        reapableRow("f-restore", "im-restore"),
      ]);
      const adapter = createAdapter();
      const { reaper } = createReaper({ store, adapter });

      const result = await reaper.cleanupImages(86_400_000, ctx);

      expect(result.reapedFailed).toBe(1);
      expect(adapter.deleteImage).toHaveBeenCalledWith(
        expect.objectContaining({
          image: { providerImageId: "im-restore", providerSessionId: null },
        })
      );
      // The failed row itself is kept for visibility — only the artifact
      // columns are nulled; it is never reaped as a superseded row.
      expect(store.clearFailedImageArtifact).toHaveBeenCalledWith("f-restore", "im-restore");
      expect(store.deleteSupersededImage).not.toHaveBeenCalledWith("f-restore");
    });

    it("keeps a failed row's artifact when the provider delete fails", async () => {
      const store = createStore();
      store.getFailedImagesWithArtifacts.mockResolvedValue([reapableRow("f-stuck", "im-stuck")]);
      const adapter = createAdapter();
      adapter.deleteImage.mockRejectedValue(new Error("provider 500"));
      const { reaper } = createReaper({ store, adapter });

      const result = await reaper.cleanupImages(86_400_000, ctx);

      // Artifact not lost: the columns are left intact so the next tick retries.
      expect(result.reapedFailed).toBe(0);
      expect(store.clearFailedImageArtifact).not.toHaveBeenCalled();
    });

    it("attempts every failed artifact in one cleanup scan", async () => {
      const store = createStore();
      const rows = Array.from({ length: 26 }, (_, index) =>
        reapableRow(`failed-${index + 1}`, `im-${index + 1}`)
      );
      store.getFailedImagesWithArtifacts.mockResolvedValue(rows);
      const adapter = createAdapter();
      let inFlight = 0;
      let peakInFlight = 0;
      adapter.deleteImage.mockImplementation(async ({ image }) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        if (image.providerImageId === "im-1") throw new Error("provider unavailable");
      });
      const { reaper } = createReaper({ store, adapter });

      const result = await reaper.cleanupImages(86_400_000, ctx);

      expect(result.reapedFailed).toBe(25);
      expect(peakInFlight).toBeLessThanOrEqual(4);
      expect(store.getFailedImagesWithArtifacts).toHaveBeenCalledWith();
      expect(store.clearFailedImageArtifact).toHaveBeenCalledWith("failed-26", "im-26");
    });

    it("does not select already-reaped failed rows (idempotent across ticks)", async () => {
      const store = createStore();
      // getFailedImagesWithArtifacts only returns artifact-bearing rows, so a
      // previously-cleared failed row never reaches the adapter again.
      store.getFailedImagesWithArtifacts.mockResolvedValue([]);
      const adapter = createAdapter();
      const { reaper } = createReaper({ store, adapter });

      const result = await reaper.cleanupImages(86_400_000, ctx);

      expect(result.reapedFailed).toBe(0);
      expect(adapter.deleteImage).not.toHaveBeenCalled();
      expect(store.clearFailedImageArtifact).not.toHaveBeenCalled();
    });

    it("bounds a hung provider artifact deletion", async () => {
      vi.useFakeTimers();
      try {
        const store = createStore();
        store.getFailedImagesWithArtifacts.mockResolvedValue([reapableRow("f-hung", "im-hung")]);
        const adapter = createAdapter();
        adapter.deleteImage.mockImplementation(
          async ({ signal }) =>
            new Promise<void>((_, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("aborted")));
            })
        );
        const { reaper } = createReaper({ store, adapter });

        const cleanup = reaper.cleanupImages(86_400_000, ctx);
        await vi.advanceTimersByTimeAsync(IMAGE_BUILD_CLEANUP_ATTEMPT_MS);

        await expect(cleanup).resolves.toMatchObject({ reapedFailed: 0 });
        expect(store.clearFailedImageArtifact).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

const now = 10_000_000;
/**
 * Registered long enough ago that the build's source has certainly outlived
 * its hard lifetime: an absent resource can no longer be explained by a
 * create or a capture still in flight.
 */
const conclusivelyAbsentAt = now - (DEFAULT_STALE_BUILD_MAX_AGE_MS + 1);

describe("ImageBuildReaper unbound source recovery", () => {
  const intent = (id: string, createdAt: number) => ({
    id,
    provider: "daytona" as const,
    created_at: createdAt,
  });

  it("attaches a source found under its reserved name for teardown", async () => {
    const store = createStore();
    store.listUnboundSourceIntents.mockResolvedValue([intent("b-1", now - 1000)]);
    const adapter = createRecoverableAdapter();
    adapter.recoverUnboundSource.mockResolvedValue({ providerSessionId: "sandbox-7" });
    const { reaper } = createReaper({ store, adapter });

    const result = await reaper.recoverUnboundSources(ctx, now);

    expect(result).toEqual({ recovered: 1, cleared: 0, retained: 0 });
    expect(store.attachRecoveredProviderSession).toHaveBeenCalledWith(
      "b-1",
      "daytona",
      "sandbox-7"
    );
    expect(store.clearUnboundSourceIntent).not.toHaveBeenCalled();
  });

  it("keeps an intent whose create could still be in flight", async () => {
    const store = createStore();
    store.listUnboundSourceIntents.mockResolvedValue([intent("b-1", now - 1000)]);
    const { reaper } = createReaper({ store, adapter: createRecoverableAdapter() });

    const result = await reaper.recoverUnboundSources(ctx, now);

    expect(result).toEqual({ recovered: 0, cleared: 0, retained: 1 });
    expect(store.clearUnboundSourceIntent).not.toHaveBeenCalled();
  });

  it("settles an intent only once an absent source cannot be explained by timing", async () => {
    const store = createStore();
    store.listUnboundSourceIntents.mockResolvedValue([intent("b-1", conclusivelyAbsentAt)]);
    const { reaper } = createReaper({ store, adapter: createRecoverableAdapter() });

    const result = await reaper.recoverUnboundSources(ctx, now);

    expect(result).toEqual({ recovered: 0, cleared: 1, retained: 0 });
    expect(store.clearUnboundSourceIntent).toHaveBeenCalledWith("b-1");
  });

  it("keeps an intent the provider could not be asked about", async () => {
    const store = createStore();
    store.listUnboundSourceIntents.mockResolvedValue([intent("b-1", conclusivelyAbsentAt)]);
    const adapter = createRecoverableAdapter();
    adapter.recoverUnboundSource.mockRejectedValue(new Error("provider 503"));
    const { reaper } = createReaper({ store, adapter });

    const result = await reaper.recoverUnboundSources(ctx, now);

    expect(result).toEqual({ recovered: 0, cleared: 0, retained: 1 });
    expect(store.clearUnboundSourceIntent).not.toHaveBeenCalled();
  });

  it("leaves providers that cannot recover a source by name alone", async () => {
    const store = createStore();
    store.listUnboundSourceIntents.mockResolvedValue([intent("b-1", conclusivelyAbsentAt)]);
    const { reaper } = createReaper({ store, adapter: createAdapter() });

    const result = await reaper.recoverUnboundSources(ctx, now);

    expect(result).toEqual({ recovered: 0, cleared: 0, retained: 0 });
    expect(store.clearUnboundSourceIntent).not.toHaveBeenCalled();
  });
});

describe("ImageBuildReaper orphan operation reconciliation", () => {
  const operation = (id: string, createdAt: number = conclusivelyAbsentAt) => ({
    id,
    provider: "daytona" as const,
    provider_session_id: "sandbox-7",
    provider_operation_ref: `oi-image-${id}`,
    created_at: createdAt,
  });

  it("settles an operation whose artifact was reclaimed", async () => {
    const store = createStore();
    store.listUnresolvedOperations.mockResolvedValue([operation("b-1", now - 1000)]);
    const adapter = createRecoverableAdapter();
    adapter.reconcileOrphanOperation.mockResolvedValue({ type: "deleted" });
    const { reaper } = createReaper({ store, adapter });

    const result = await reaper.reconcileUnresolvedOperations(ctx, now);

    // Deletion is conclusive whenever it happens, so the row is freed on the
    // pass that observes it.
    expect(result).toEqual({ reconciled: 1, retained: 0 });
    expect(store.clearProviderOperation).toHaveBeenCalledWith("b-1", "oi-image-b-1");
  });

  it("settles an absent operation only once a capture can no longer be running", async () => {
    const store = createStore();
    store.listUnresolvedOperations.mockResolvedValue([operation("b-1")]);
    const adapter = createRecoverableAdapter();
    adapter.reconcileOrphanOperation.mockResolvedValue({ type: "absent" });
    const { reaper } = createReaper({ store, adapter });

    const result = await reaper.reconcileUnresolvedOperations(ctx, now);

    expect(result).toEqual({ reconciled: 1, retained: 0 });
    expect(store.clearProviderOperation).toHaveBeenCalledWith("b-1", "oi-image-b-1");
  });

  it("keeps an absent operation whose capture could still produce a snapshot", async () => {
    const store = createStore();
    store.listUnresolvedOperations.mockResolvedValue([operation("b-1", now - 1000)]);
    const adapter = createRecoverableAdapter();
    adapter.reconcileOrphanOperation.mockResolvedValue({ type: "absent" });
    const { reaper } = createReaper({ store, adapter });

    const result = await reaper.reconcileUnresolvedOperations(ctx, now);

    // A snapshot record can appear well after its capture was accepted;
    // clearing the reference on the first 404 would leave that artifact with
    // nothing on the row naming it.
    expect(result).toEqual({ reconciled: 0, retained: 1 });
    expect(store.clearProviderOperation).not.toHaveBeenCalled();
  });

  it("keeps an operation that has not settled", async () => {
    const store = createStore();
    store.listUnresolvedOperations.mockResolvedValue([operation("b-1")]);
    const adapter = createRecoverableAdapter();
    adapter.reconcileOrphanOperation.mockResolvedValue({ type: "pending" });
    const { reaper } = createReaper({ store, adapter });

    const result = await reaper.reconcileUnresolvedOperations(ctx, now);

    expect(result).toEqual({ reconciled: 0, retained: 1 });
    expect(store.clearProviderOperation).not.toHaveBeenCalled();
  });

  it("keeps an operation the provider could not be asked about", async () => {
    const store = createStore();
    store.listUnresolvedOperations.mockResolvedValue([operation("b-1")]);
    const adapter = createRecoverableAdapter();
    adapter.reconcileOrphanOperation.mockRejectedValue(new Error("provider 503"));
    const { reaper } = createReaper({ store, adapter });

    const result = await reaper.reconcileUnresolvedOperations(ctx, now);

    expect(result).toEqual({ reconciled: 0, retained: 1 });
    expect(store.clearProviderOperation).not.toHaveBeenCalled();
  });

  it("leaves providers that cannot reconcile an operation alone", async () => {
    const store = createStore();
    store.listUnresolvedOperations.mockResolvedValue([operation("b-1")]);
    const { reaper } = createReaper({ store, adapter: createAdapter() });

    const result = await reaper.reconcileUnresolvedOperations(ctx, now);

    expect(result).toEqual({ reconciled: 0, retained: 0 });
    expect(store.clearProviderOperation).not.toHaveBeenCalled();
  });
});
