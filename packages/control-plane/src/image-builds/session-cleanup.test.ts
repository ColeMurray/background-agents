import { describe, expect, it, vi } from "vitest";
import type { ImageBuildStore } from "../db/image-builds";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { IMAGE_BUILD_CLEANUP_ATTEMPT_MS } from "./reaper";
import { ImageBuildSessionCleanup } from "./session-cleanup";

const correlation = { request_id: "cleanup-1", trace_id: "cleanup-1" };

function harness() {
  const clearSessionCleanup = vi.fn(async () => true);
  const store = {
    finalization: { clearSessionCleanup },
  } as unknown as ImageBuildStore;
  const adapter = {
    startBuild: vi.fn(),
    deleteImage: vi.fn(),
    cleanupCompletedBuild: vi.fn(async (_input: { signal?: AbortSignal }) => undefined),
    cleanupFailedBuild: vi.fn(async (_input: { signal?: AbortSignal }) => undefined),
  };
  const factory = {
    create: vi.fn(() => adapter),
  } as unknown as ImageBuildAdapterFactory;
  return {
    cleanup: new ImageBuildSessionCleanup(store, factory),
    adapter,
    clearSessionCleanup,
  };
}

describe("ImageBuildSessionCleanup", () => {
  it("uses one completed-session path and clears the exact obligation", async () => {
    const { cleanup, adapter, clearSessionCleanup } = harness();

    await cleanup.run(
      {
        id: "build-ready",
        provider: "modal",
        provider_image_id: "image-1",
        provider_session_id: "session-1",
        provider_session_cleanup_pending: 1,
        error_message: null,
      },
      correlation
    );

    expect(adapter.cleanupCompletedBuild).toHaveBeenCalledWith({
      buildId: "build-ready",
      providerSessionId: "session-1",
      correlation,
      signal: expect.any(AbortSignal),
    });
    expect(adapter.cleanupFailedBuild).not.toHaveBeenCalled();
    expect(clearSessionCleanup).toHaveBeenCalledWith({
      buildId: "build-ready",
      provider: "modal",
      providerSessionId: "session-1",
    });
  });

  it("reports when the fenced cleanup obligation was not cleared", async () => {
    const { cleanup, clearSessionCleanup } = harness();
    clearSessionCleanup.mockResolvedValueOnce(false);

    const cleared = await cleanup.run(
      {
        id: "build-ready",
        provider: "modal",
        provider_image_id: "image-1",
        provider_session_id: "session-1",
        provider_session_cleanup_pending: 1,
        error_message: null,
      },
      correlation
    );

    expect(cleared).toBe(false);
  });

  it("handles legacy null flags and bounds failed-session cleanup", async () => {
    vi.useFakeTimers();
    try {
      const { cleanup, adapter, clearSessionCleanup } = harness();
      adapter.cleanupFailedBuild.mockImplementation(
        async ({ signal }: { signal?: AbortSignal }) =>
          new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("operation aborted")));
          })
      );

      const operation = cleanup.run(
        {
          id: "build-failed",
          provider: "vercel",
          provider_image_id: null,
          provider_session_id: "session-2",
          provider_session_cleanup_pending: null,
          error_message: "setup failed",
        },
        correlation
      );
      const rejection = expect(operation).rejects.toThrow("operation aborted");
      await vi.advanceTimersByTimeAsync(IMAGE_BUILD_CLEANUP_ATTEMPT_MS);

      await rejection;
      expect(adapter.cleanupFailedBuild).toHaveBeenCalledWith({
        buildId: "build-failed",
        providerSessionId: "session-2",
        errorMessage: "setup failed",
        correlation,
        signal: expect.any(AbortSignal),
      });
      expect(clearSessionCleanup).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
