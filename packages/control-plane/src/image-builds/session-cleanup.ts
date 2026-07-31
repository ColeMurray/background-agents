import type { ImageBuildProvider } from "./model";
import type { ImageBuildStore } from "../db/image-builds";
import type { CorrelationContext } from "../logger";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { IMAGE_BUILD_CLEANUP_ATTEMPT_MS } from "./reaper";

/** Durable row fields required to tear down one provider build session. */
export interface ImageBuildSessionCleanupTarget {
  id: string;
  provider: ImageBuildProvider;
  provider_image_id: string | null;
  provider_session_id: string | null;
  provider_session_cleanup_pending?: number | null;
  error_message?: string | null;
}

/** Idempotent provider-session teardown shared by Queue finalization and maintenance. */
export class ImageBuildSessionCleanup {
  constructor(
    private readonly store: ImageBuildStore,
    private readonly adapterFactory: ImageBuildAdapterFactory,
    private readonly attemptTimeoutMs = IMAGE_BUILD_CLEANUP_ATTEMPT_MS
  ) {}

  /**
   * Runs the provider-specific terminal cleanup and clears the obligation only
   * after the provider call succeeds. Returns false when cleanup was already
   * completed or no provider session was ever bound.
   */
  async run(
    target: ImageBuildSessionCleanupTarget,
    correlation: CorrelationContext
  ): Promise<boolean> {
    if (!target.provider_session_id || target.provider_session_cleanup_pending === 0) return false;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.attemptTimeoutMs);
    try {
      const adapter = this.adapterFactory.create(target.provider, "existing_session");
      if (target.provider_image_id) {
        await adapter.cleanupCompletedBuild({
          buildId: target.id,
          providerSessionId: target.provider_session_id,
          correlation,
          signal: controller.signal,
        });
      } else {
        await adapter.cleanupFailedBuild({
          buildId: target.id,
          providerSessionId: target.provider_session_id,
          errorMessage: target.error_message ?? "image build failed",
          correlation,
          signal: controller.signal,
        });
      }
      return await this.store.finalization.clearSessionCleanup({
        buildId: target.id,
        provider: target.provider,
        providerSessionId: target.provider_session_id,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
