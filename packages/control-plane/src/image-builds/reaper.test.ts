import { describe, expect, it, vi } from "vitest";
import type { ImageBuildStore } from "../db/image-builds";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { IMAGE_BUILD_CLEANUP_ATTEMPT_MS, ImageBuildReaper } from "./reaper";

const ctx = { trace_id: "t", request_id: "r" };

function createStore() {
  return {
    getFailedImagesWithArtifacts: vi.fn().mockResolvedValue([]),
    deleteOldFailedBuilds: vi.fn().mockResolvedValue(0),
    getSupersededImages: vi.fn().mockResolvedValue([]),
    deleteSupersededImage: vi.fn().mockResolvedValue(true),
    clearFailedImageArtifact: vi.fn().mockResolvedValue(true),
  };
}

function createAdapter() {
  return {
    deleteImage: vi.fn().mockResolvedValue(undefined),
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
