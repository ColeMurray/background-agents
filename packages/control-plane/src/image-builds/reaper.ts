import type { ImageBuildStore, ReapableImageBuildRow } from "../db/image-builds";
import { createLogger } from "../logger";
import type { ImageBuildProvider, SupersededImageBuild } from "./model";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import type { AnyImageBuildAdapter, ImageBuildWorkflowContext } from "./types";

const logger = createLogger("image-builds:reaper");

/** Rows reclaimed per cleanup pass, per sweep; leftovers wait for the next tick. */
const REAP_BATCH_LIMIT = 25;
export const IMAGE_BUILD_CLEANUP_ATTEMPT_MS = 10_000;
const FAILED_ARTIFACT_CURSOR = "failed-image-artifact-cleanup";
const SUPERSEDED_ARTIFACT_CURSOR = "superseded-image-artifact-cleanup";

type AdapterCache = Map<ImageBuildProvider, AnyImageBuildAdapter | null>;

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
   * Cleanup pass. Reaps provider artifacts through one best-effort machinery:
   *
   * - Failed-with-artifact rows first (restore-failed spawns leave a live
   *   provider_image_id on a failed row): delete the artifact, then null the
   *   row's artifact columns while keeping it `failed` so its error_message
   *   stays visible. Doing this before the age sweep lets a now-artifact-free
   *   old row be deleted in the same pass.
   * - Old failed rows: deleted only once artifact-free (the store scopes the
   *   DELETE to provider_image_id IS NULL).
   * - Superseded rows: delete the artifact (when one was recorded), then the
   *   row itself. Covers inline supersedes whose deletion failed and
   *   out-of-band supersedes (entity delete, secret change).
   *
   * Every artifact delete degrades instead of throwing — a failed delete
   * leaves the artifact on its row for the next tick to retry.
   */
  async cleanupImages(
    failedMaxAgeMs: number,
    ctx: ImageBuildWorkflowContext
  ): Promise<{ deletedFailed: number; reapedFailed: number; reapedSuperseded: number }> {
    const adapters: AdapterCache = new Map();

    const failedRows = await this.getRotatingPage(FAILED_ARTIFACT_CURSOR, (after) =>
      this.store.getFailedImagesWithArtifacts(REAP_BATCH_LIMIT, after)
    );
    const reapedFailed = await this.reapArtifactBearingRows(failedRows, ctx, adapters, (row) =>
      this.store.clearFailedImageArtifact(row.id, row.provider_image_id)
    );

    const deletedFailed = await this.store.deleteOldFailedBuilds(failedMaxAgeMs);

    const supersededRows = await this.getRotatingPage(SUPERSEDED_ARTIFACT_CURSOR, (after) =>
      this.store.getSupersededImages(REAP_BATCH_LIMIT, after)
    );
    const reapedSuperseded = await this.reapArtifactBearingRows(
      supersededRows,
      ctx,
      adapters,
      (row) => this.store.deleteSupersededImage(row.id, row.provider_image_id)
    );

    return { deletedFailed, reapedFailed, reapedSuperseded };
  }

  /**
   * Advance a persisted keyset cursor before provider calls. A provider
   * failure therefore waits for one bounded rotation instead of pinning every
   * later artifact behind the oldest rows forever.
   */
  private async getRotatingPage(
    cursorName: string,
    select: (after: { createdAt: number; rowId: string } | null) => Promise<ReapableImageBuildRow[]>
  ): Promise<ReapableImageBuildRow[]> {
    const stored = await this.store.maintenance.getCursor(cursorName);
    let after =
      stored?.createdAt !== null &&
      stored?.createdAt !== undefined &&
      stored.rowId !== null &&
      stored.rowId !== undefined
        ? { createdAt: stored.createdAt, rowId: stored.rowId }
        : null;
    let rows = await select(after);
    if (rows.length === 0 && after) {
      after = null;
      rows = await select(null);
    }

    const last = rows.at(-1);
    await this.store.maintenance.setCursor(cursorName, {
      scopeKind: null,
      scopeId: null,
      createdAt: rows.length === REAP_BATCH_LIMIT && last ? last.created_at : null,
      rowId: rows.length === REAP_BATCH_LIMIT && last ? last.id : null,
    });
    return rows;
  }

  /**
   * Shared reap loop: for each artifact-bearing row, delete the provider
   * artifact best-effort and run the terminal store action only once it is
   * gone, so a failed provider delete keeps the artifact on its row. Rows with
   * no artifact skip straight to the terminal action (a bare superseded row is
   * reaped directly). Returns how many terminal actions committed.
   */
  private async reapArtifactBearingRows(
    rows: ReapableImageBuildRow[],
    ctx: ImageBuildWorkflowContext,
    adapters: AdapterCache,
    commit: (row: ReapableImageBuildRow) => Promise<boolean>
  ): Promise<number> {
    let reaped = 0;
    await Promise.all(
      rows.map(async (row) => {
        if (row.provider_image_id) {
          const adapter = this.resolveCleanupAdapter(row.provider, row.id, ctx, adapters);
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
        if (await commit(row)) reaped += 1;
      })
    );
    return reaped;
  }

  private resolveCleanupAdapter(
    provider: ImageBuildProvider,
    buildId: string,
    ctx: ImageBuildWorkflowContext,
    adapters: AdapterCache
  ): AnyImageBuildAdapter | null {
    if (!adapters.has(provider)) {
      adapters.set(provider, this.createAdapterForBestEffortCleanup(provider, buildId, ctx));
    }
    return adapters.get(provider) ?? null;
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
            await this.store.deleteSupersededImage(
              replacedImage.imageBuildId,
              replacedImage.image.providerImageId
            );
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_BUILD_CLEANUP_ATTEMPT_MS);
    try {
      await adapter.deleteImage({
        image,
        correlation: ctx,
        signal: controller.signal,
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
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Null (never throws) when the provider is unconfigured — cleanup is best-effort. */
  createAdapterForBestEffortCleanup(
    provider: ImageBuildProvider,
    buildId: string,
    ctx: ImageBuildWorkflowContext
  ): AnyImageBuildAdapter | null {
    try {
      return this.adapterFactory.create(provider, "existing_session");
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
