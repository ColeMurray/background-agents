import type { ImageBuildStore } from "../db/image-builds";
import { createLogger } from "../logger";
import type { ImageBuildProvider, SupersededImageBuild } from "./model";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import type { AnyImageBuildAdapter, ImageBuildWorkflowContext } from "./types";

const logger = createLogger("image-builds:reaper");

/** Superseded rows reclaimed per cleanup pass; leftovers wait for the next tick. */
const SUPERSEDED_REAP_BATCH_LIMIT = 25;

/**
 * Best-effort provider-artifact reclamation: inline deletion of images a
 * mark-ready replaced, and the cleanup sweep over failed and superseded rows.
 * Everything here degrades instead of throwing — a failed provider delete
 * leaves the row in place so the next pass retries it.
 */
export class ImageBuildReaper {
  constructor(
    private readonly store: ImageBuildStore,
    private readonly adapterFactory: ImageBuildAdapterFactory
  ) {}

  /**
   * Cleanup pass: delete old failed rows, then reap superseded rows — delete
   * the provider artifact (when one was recorded) and only then the row, so a
   * failed artifact delete is retried on the next pass. Covers both inline
   * supersedes whose deletion failed and out-of-band supersedes (entity
   * delete, secret change), which nothing deletes inline.
   */
  async cleanupImages(
    failedMaxAgeMs: number,
    ctx: ImageBuildWorkflowContext
  ): Promise<{ deletedFailed: number; reapedSuperseded: number }> {
    const deletedFailed = await this.store.deleteOldFailedBuilds(failedMaxAgeMs);

    const superseded = await this.store.getSupersededImages(SUPERSEDED_REAP_BATCH_LIMIT);
    let reapedSuperseded = 0;
    const adaptersByProvider = new Map<ImageBuildProvider, AnyImageBuildAdapter | null>();
    await Promise.all(
      superseded.map(async (row) => {
        if (row.provider_image_id) {
          if (!adaptersByProvider.has(row.provider)) {
            adaptersByProvider.set(
              row.provider,
              this.createAdapterForBestEffortCleanup(row.provider, row.id, ctx)
            );
          }
          const adapter = adaptersByProvider.get(row.provider) ?? null;
          if (!adapter) return;
          const deleted = await this.deleteImageBestEffort(
            row.provider,
            {
              providerImageId: row.provider_image_id,
              providerSessionId: row.provider_session_id,
            },
            ctx,
            adapter
          );
          if (!deleted) return;
        }
        if (await this.store.deleteSupersededImage(row.id)) {
          reapedSuperseded += 1;
        }
      })
    );

    return { deletedFailed, reapedSuperseded };
  }

  /** Delete the artifacts (and rows) of images a newer ready build replaced. */
  deleteReplacedImages(
    provider: ImageBuildProvider,
    replacedImages: SupersededImageBuild[],
    ctx: ImageBuildWorkflowContext
  ): Promise<void> | undefined {
    if (replacedImages.length === 0) return undefined;

    const adapter = this.createAdapterForBestEffortCleanup(
      provider,
      replacedImages[0].imageBuildId,
      ctx
    );
    if (!adapter) return undefined;

    return Promise.all(
      replacedImages.map(async (replacedImage) => {
        // Rows superseded before an artifact was recorded have nothing to
        // delete provider-side; the cleanup sweep removes the row.
        if (!replacedImage.image.providerImageId) return;
        const deleted = await this.deleteImageBestEffort(
          provider,
          replacedImage.image,
          ctx,
          adapter
        );
        if (deleted) {
          try {
            await this.store.deleteSupersededImage(replacedImage.imageBuildId);
          } catch (e) {
            logger.warn("image_build.delete_superseded_row_failed", {
              image_build_id: replacedImage.imageBuildId,
              provider_image_id: replacedImage.image.providerImageId,
              error: errorMessage(e),
              request_id: ctx.request_id,
              trace_id: ctx.trace_id,
            });
          }
        }
      })
    ).then(() => undefined);
  }

  async deleteImageBestEffort(
    provider: ImageBuildProvider,
    image: { providerImageId: string; providerSessionId?: string | null },
    ctx: ImageBuildWorkflowContext,
    adapter: AnyImageBuildAdapter
  ): Promise<boolean> {
    try {
      await adapter.deleteImage({
        image,
        correlation: ctx,
      });
      return true;
    } catch (e) {
      logger.warn("image_build.delete_old_failed", {
        provider,
        provider_image_id: image.providerImageId,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return false;
    }
  }

  /** Null (never throws) when the provider is unconfigured — cleanup is best-effort. */
  createAdapterForBestEffortCleanup(
    provider: ImageBuildProvider,
    buildId: string,
    ctx: ImageBuildWorkflowContext
  ): AnyImageBuildAdapter | null {
    try {
      return this.adapterFactory.create(provider);
    } catch (e) {
      logger.error("image_build.adapter_config_error", {
        operation: "cleanup",
        build_id: buildId,
        provider,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return null;
    }
  }
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
