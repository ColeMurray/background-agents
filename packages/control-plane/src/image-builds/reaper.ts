import type {
  ImageBuildStore,
  ReapableImageBuildRow,
  UnboundSourceIntentRow,
  UnresolvedProviderOperationRow,
} from "../db/image-builds";
import { createLogger } from "../logger";
import { errorMessage } from "./errors";
import { DEFAULT_STALE_BUILD_MAX_AGE_MS } from "./maintenance";
import type { ImageBuildProvider, SupersededImageBuild } from "./model";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import type { ImageBuildAdapter, ImageBuildWorkflowContext } from "./types";
import { runMaintenanceTasks } from "./concurrency";

const logger = createLogger("image-builds:reaper");

export const IMAGE_BUILD_CLEANUP_ATTEMPT_MS = 10_000;

/**
 * Age past which an outstanding obligation is worth an operator's attention.
 * Well past the cron's own cadence and the longest source lifetime, so a
 * warning means something is genuinely stuck rather than merely in progress.
 */
const IMAGE_BUILD_STUCK_OBLIGATION_ALERT_MS = 6 * 60 * 60 * 1000;

/** What one unbound-source recovery pass settled. */
export interface ImageBuildSourceRecoveryResult {
  /** Sources found provider-side and attached to their row for teardown. */
  recovered: number;
  /** Intents settled because no source was ever created. */
  cleared: number;
  /** Intents left outstanding for the next pass. */
  retained: number;
}

/** What one orphaned-operation pass settled. */
export interface ImageBuildOperationReconciliationResult {
  /** Operations whose artifact was reclaimed, or established never to exist. */
  reconciled: number;
  /** Operations left outstanding for the next pass. */
  retained: number;
}

type AdapterCache = Map<ImageBuildProvider, ImageBuildAdapter | null>;

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

    const failedRows = await this.store.getFailedImagesWithArtifacts();
    const reapedFailed = await this.reapArtifactBearingRows(failedRows, ctx, adapters, (row) =>
      this.store.clearFailedImageArtifact(row.id, row.provider_image_id)
    );

    const deletedFailed = await this.store.deleteOldFailedBuilds(failedMaxAgeMs);

    const supersededRows = await this.store.getSupersededImages();
    const reapedSuperseded = await this.reapArtifactBearingRows(
      supersededRows,
      ctx,
      adapters,
      (row) => this.store.deleteSupersededImage(row.id, row.provider_image_id)
    );

    return { deletedFailed, reapedFailed, reapedSuperseded };
  }

  /**
   * Resolves build sources whose create response was never seen.
   *
   * The row carries a cleanup obligation with no id to act on, so the source
   * is looked up by the name reserved for it. Found, it is attached to the row
   * for cleanup only — never as a binding that could authorize a launch or a
   * callback — and the session-cleanup pass tears it down. Not found, the
   * intent is only settled once an in-flight create can no longer explain the
   * absence: until the source's hard lifetime has certainly elapsed, a 404 is
   * a timing answer, not a conclusive one.
   *
   * Providers whose adapter cannot find a source by name are skipped: they
   * never record the intent in the first place.
   */
  async recoverUnboundSources(
    ctx: ImageBuildWorkflowContext,
    now: number = Date.now()
  ): Promise<ImageBuildSourceRecoveryResult> {
    const rows = await this.store.listUnboundSourceIntents();
    const adapters: AdapterCache = new Map();
    const result: ImageBuildSourceRecoveryResult = { recovered: 0, cleared: 0, retained: 0 };

    await runMaintenanceTasks(rows, async (row) => {
      const adapter = this.resolveCleanupAdapter(row.provider, row.id, ctx, adapters);
      if (!adapter?.recoverUnboundSource) return;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), IMAGE_BUILD_CLEANUP_ATTEMPT_MS);
      try {
        const source = await adapter.recoverUnboundSource({
          buildId: row.id,
          correlation: ctx,
          signal: controller.signal,
        });
        if (source) {
          if (
            await this.store.attachRecoveredProviderSession(
              row.id,
              row.provider,
              source.providerSessionId
            )
          ) {
            result.recovered += 1;
          }
          return;
        }
        if (now - row.created_at <= DEFAULT_STALE_BUILD_MAX_AGE_MS) {
          this.retainSourceIntent(row, result, ctx, "create_may_be_in_flight");
          return;
        }
        if (await this.store.clearUnboundSourceIntent(row.id)) result.cleared += 1;
      } catch (error) {
        this.retainSourceIntent(row, result, ctx, errorMessage(error));
      } finally {
        clearTimeout(timeoutId);
      }
    });

    return result;
  }

  /**
   * Settles artifact operations left behind by builds that failed or were
   * superseded before their capture produced a tracked artifact.
   *
   * An accepted capture can still become visible after the build that ordered
   * it is terminal, so the reserved name is the only handle to a resource
   * nothing else records. A pending outcome keeps the obligation rather than
   * dropping it — an untracked billable artifact is strictly worse than a row
   * that keeps asking. So does an absent one, until a capture can no longer
   * be running at all: a lookup that finds nothing is a timing answer until
   * the source the capture reads has certainly expired.
   */
  async reconcileUnresolvedOperations(
    ctx: ImageBuildWorkflowContext,
    now: number = Date.now()
  ): Promise<ImageBuildOperationReconciliationResult> {
    const rows = await this.store.listUnresolvedOperations();
    const adapters: AdapterCache = new Map();
    const result: ImageBuildOperationReconciliationResult = { reconciled: 0, retained: 0 };

    await runMaintenanceTasks(rows, async (row) => {
      const adapter = this.resolveCleanupAdapter(row.provider, row.id, ctx, adapters);
      if (!adapter?.reconcileOrphanOperation) return;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), IMAGE_BUILD_CLEANUP_ATTEMPT_MS);
      try {
        const outcome = await adapter.reconcileOrphanOperation({
          buildId: row.id,
          operationRef: row.provider_operation_ref,
          providerSessionId: row.provider_session_id,
          correlation: ctx,
          signal: controller.signal,
        });
        if (outcome.type === "pending") {
          this.retainOperation(row, result, ctx, now, "operation_still_settling");
          return;
        }
        // Finding nothing under the reserved name is not yet evidence that
        // nothing was produced: the record can appear well after the capture
        // was accepted. Only once the source it reads has certainly outlived
        // its hard lifetime can a later artifact no longer arrive, which is
        // the same bound an unbound create intent settles on.
        if (outcome.type === "absent" && now - row.created_at <= DEFAULT_STALE_BUILD_MAX_AGE_MS) {
          this.retainOperation(row, result, ctx, now, "capture_may_still_be_running");
          return;
        }
        if (await this.store.clearProviderOperation(row.id, row.provider_operation_ref)) {
          result.reconciled += 1;
        }
      } catch (error) {
        this.retainOperation(row, result, ctx, now, errorMessage(error));
      } finally {
        clearTimeout(timeoutId);
      }
    });

    return result;
  }

  private retainSourceIntent(
    row: UnboundSourceIntentRow,
    result: ImageBuildSourceRecoveryResult,
    ctx: ImageBuildWorkflowContext,
    reason: string
  ): void {
    result.retained += 1;
    logger.warn("image_build.source_intent_unresolved", {
      build_id: row.id,
      provider: row.provider,
      created_at: row.created_at,
      reason,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }

  private retainOperation(
    row: UnresolvedProviderOperationRow,
    result: ImageBuildOperationReconciliationResult,
    ctx: ImageBuildWorkflowContext,
    now: number,
    reason: string
  ): void {
    result.retained += 1;
    const context = {
      build_id: row.id,
      provider: row.provider,
      provider_operation_ref: row.provider_operation_ref,
      created_at: row.created_at,
      reason,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    };
    if (now - row.created_at > IMAGE_BUILD_STUCK_OBLIGATION_ALERT_MS) {
      logger.error("image_build.operation_unresolved", context);
      return;
    }
    logger.warn("image_build.operation_unresolved", context);
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
    await runMaintenanceTasks(rows, async (row) => {
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
    });
    return reaped;
  }

  private resolveCleanupAdapter(
    provider: ImageBuildProvider,
    buildId: string,
    ctx: ImageBuildWorkflowContext,
    adapters: AdapterCache
  ): ImageBuildAdapter | null {
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

  private async deleteImageBestEffort(
    provider: ImageBuildProvider,
    image: { providerImageId: string; providerSessionId?: string | null },
    ctx: ImageBuildWorkflowContext,
    adapter: ImageBuildAdapter
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
  private createAdapterForBestEffortCleanup(
    provider: ImageBuildProvider,
    buildId: string,
    ctx: ImageBuildWorkflowContext
  ): ImageBuildAdapter | null {
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
