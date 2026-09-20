import { generateId } from "../auth/crypto";
import type { ImageBuildFinalizationRow } from "../db/image-build-finalization";
import type { ImageBuildStore } from "../db/image-builds";
import type { CorrelationContext } from "../logger";
import type { ImageBuildFinalizationJob } from "./finalization-job";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { ImageBuildReaper } from "./reaper";
import { ImageBuildSessionCleanup } from "./session-cleanup";
import type { ImageBuildAdapter } from "./types";
import { errorMessage } from "./errors";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import { parseRepositoryShasJson } from "./provenance";

/** Lease exceeds the provider deadline so overlapping creation attempts cannot run. */
const IMAGE_BUILD_FINALIZATION_LEASE_MS = 6 * 60 * 1000;

/** Hard deadline for one provider snapshot or checkpoint attempt. */
export const IMAGE_BUILD_PROVIDER_ATTEMPT_MS = 5 * 60 * 1000;
export const IMAGE_BUILD_FINALIZATION_RETRY_DELAY_MS = 15_000;
/**
 * Cadence for polling an artifact operation the provider has accepted but not
 * finished. Longer than the lease-contention retry: nothing here is contended,
 * the work is the provider's, and the operation's own fixed deadline — not the
 * number of polls — is what ends it.
 */
export const IMAGE_BUILD_PENDING_OPERATION_RETRY_DELAY_MS = 30_000;
const LEASE_EXPIRY_HEADROOM_MS = 5_000;

/**
 * Job disposition returned after processing one finalization command.
 *
 * `pending_operation` distinguishes waiting on the provider from waiting on a
 * lease: the host may exhaust a job's delivery budget long before a capture
 * settles, so that retry is the one worth republishing with a fresh budget.
 */
export type ImageBuildFinalizationResult =
  | { type: "completed" }
  | { type: "retry"; delayMs: number; reason?: "pending_operation" };

const completed = (): ImageBuildFinalizationResult => ({ type: "completed" });
const retrySoon = (): ImageBuildFinalizationResult => ({
  type: "retry",
  delayMs: IMAGE_BUILD_FINALIZATION_RETRY_DELAY_MS,
});
const retryPendingOperation = (): ImageBuildFinalizationResult => ({
  type: "retry",
  delayMs: IMAGE_BUILD_PENDING_OPERATION_RETRY_DELAY_MS,
  reason: "pending_operation",
});

/**
 * Resumes accepted image builds from D1 and advances them through provider
 * artifact creation, fenced persistence, ready-state publication, and
 * idempotent provider-session teardown.
 */
export class ImageBuildFinalizer {
  private readonly reaper: ImageBuildReaper;
  private readonly sessionCleanup: ImageBuildSessionCleanup;

  constructor(
    private readonly store: ImageBuildStore,
    private readonly adapterFactory: ImageBuildAdapterFactory,
    private readonly now: () => number = Date.now
  ) {
    this.reaper = new ImageBuildReaper(store, adapterFactory);
    this.sessionCleanup = new ImageBuildSessionCleanup(store, adapterFactory);
  }

  /**
   * Processes one at-least-once Queue delivery.
   *
   * The completion hash rejects stale commands, the lease serializes provider
   * work, and a persisted artifact is always resumed rather than recreated.
   */
  async process(
    job: ImageBuildFinalizationJob,
    correlation: CorrelationContext
  ): Promise<ImageBuildFinalizationResult> {
    let build = await this.store.finalization.getBuild(job.buildId);
    if (!build) return completed();
    if (build.completion_hash !== job.completionHash) {
      return completed();
    }

    if (build.status !== "building") {
      await this.cleanupTerminalBuild(build, correlation);
      return completed();
    }
    if (!build.provider_session_id || build.callback_token_used_at === null) return retrySoon();

    const leaseToken = generateId(16);
    const now = this.now();
    const expiredAttemptWithoutArtifact =
      build.provider_image_id === null &&
      build.finalization_lease_token !== null &&
      build.finalization_lease_expires_at !== null &&
      build.finalization_lease_expires_at <= now;
    const claimed = await this.store.finalization.claimLease({
      buildId: build.id,
      completionHash: job.completionHash,
      leaseToken,
      now,
      expiresAt: now + IMAGE_BUILD_FINALIZATION_LEASE_MS,
    });
    if (!claimed) {
      const current = await this.store.finalization.getBuild(build.id);
      const delayMs = Math.max(
        IMAGE_BUILD_FINALIZATION_RETRY_DELAY_MS,
        (current?.finalization_lease_expires_at ?? now) - now
      );
      return {
        type: "retry",
        delayMs: delayMs + LEASE_EXPIRY_HEADROOM_MS,
      };
    }

    build = await this.store.finalization.getBuild(build.id);
    if (!build || build.finalization_lease_token !== leaseToken || !build.provider_session_id) {
      return retrySoon();
    }

    // An attempt that died holding the lease is only unknowable when it left
    // no operation behind. A recorded one is reconcilable by name, so the
    // conservative terminalization would fail a build whose artifact may
    // already exist — and leak it.
    if (
      expiredAttemptWithoutArtifact &&
      !build.provider_image_id &&
      !build.provider_operation_ref
    ) {
      return this.failAndCleanup(
        {
          buildId: build.id,
          leaseToken,
          error: "Previous provider finalization attempt outcome unknown after lease expiry",
        },
        correlation
      );
    }

    const adapter = this.adapterFactory.create(build.provider, "existing_session");
    let providerImageId = build.provider_image_id;
    if (!providerImageId) {
      try {
        const image = await this.finalizeWithDeadline(adapter, build, leaseToken, {
          completionHash: job.completionHash,
          providerSessionId: build.provider_session_id,
          correlation,
        });
        providerImageId = image.providerImageId;
      } catch (error) {
        if (
          error instanceof ImageBuildFinalizationAttemptError &&
          error.outcome === "definitely_not_created"
        ) {
          await this.store.finalization.clearLease(build.id, leaseToken);
          return retrySoon();
        }
        if (error instanceof ImageBuildFinalizationAttemptError && error.outcome === "pending") {
          // The operation is the provider's to finish; release the lease so the
          // next delivery reconciles it instead of racing this one.
          //
          // Only a reserved operation earns the fresh delivery budget that
          // `pending_operation` asks for: the reservation's fixed deadline is
          // what ends that wait. An attempt that reported pending before
          // reserving anything — a source that has not finished stopping —
          // has no such bound, so it spends the host's ordinary budget and
          // dead-letters if it never settles.
          const current = await this.store.finalization.getBuild(build.id);
          await this.store.finalization.clearLease(build.id, leaseToken);
          return current?.provider_operation_ref ? retryPendingOperation() : retrySoon();
        }
        const message =
          error instanceof ImageBuildFinalizationAttemptError && error.outcome === "ambiguous"
            ? `Provider finalization outcome unknown: ${errorMessage(error)}`
            : errorMessage(error);
        return this.failAndCleanup({ buildId: build.id, leaseToken, error: message }, correlation);
      }

      let recorded: boolean;
      try {
        recorded = await this.store.finalization.recordArtifact({
          buildId: build.id,
          provider: build.provider,
          providerSessionId: build.provider_session_id,
          completionHash: job.completionHash,
          leaseToken,
          providerImageId,
        });
      } catch (error) {
        // A failed D1 response does not prove the conditional write failed.
        // D1 reads are strongly consistent within this Worker, so re-read
        // before compensating: deleting an artifact that was actually
        // recorded would leave a future ready row pointing at a dead image.
        const current = await this.store.finalization.getBuild(build.id);
        if (current?.provider_image_id === providerImageId) {
          recorded = true;
        } else {
          return this.compensateUnrecordedArtifact(
            adapter,
            build,
            build.provider_session_id,
            providerImageId,
            leaseToken,
            correlation,
            error
          );
        }
      }
      if (!recorded) {
        const current = await this.store.finalization.getBuild(build.id);
        if (current?.provider_image_id !== providerImageId) {
          return this.compensateUnrecordedArtifact(
            adapter,
            build,
            build.provider_session_id,
            providerImageId,
            leaseToken,
            correlation,
            new Error("Finalized artifact lost its persistence fence")
          );
        }
      }
    }

    const repositoryShas = parseRepositoryShasJson(build.repository_shas);
    if (!repositoryShas) {
      return this.failAndCleanup(
        { buildId: build.id, leaseToken, error: "Stored repository_shas is invalid" },
        correlation
      );
    }
    const ready = await this.store.tryMarkImageBuildReady(
      build.id,
      build.provider,
      providerImageId,
      repositoryShas,
      build.runtime_version,
      build.build_duration_seconds ?? 0,
      leaseToken
    );
    if (ready.type === "not_accepting_completion") {
      const current = await this.store.finalization.getBuild(build.id);
      if (current && current.status !== "building") {
        await this.cleanupTerminalBuild(current, correlation);
        return completed();
      }
      await this.store.finalization.clearLease(build.id, leaseToken);
      return retrySoon();
    }

    const replaced =
      ready.type === "marked_ready" ? ready.supersededImages : [ready.supersededImage];
    await this.reaper.deleteReplacedImages(build.provider, replaced, correlation);

    const terminal = await this.store.finalization.getBuild(build.id);
    if (terminal) await this.cleanupTerminalBuild(terminal, correlation);
    return completed();
  }

  /**
   * Removes an artifact that could not be fenced. If deletion also fails, the
   * artifact is quarantined on the row so maintenance can reap it later.
   */
  private async compensateUnrecordedArtifact(
    adapter: ImageBuildAdapter,
    build: ImageBuildFinalizationRow,
    providerSessionId: string,
    providerImageId: string,
    leaseToken: string,
    correlation: CorrelationContext,
    persistenceError: unknown
  ): Promise<ImageBuildFinalizationResult> {
    try {
      await adapter.deleteImage({
        image: { providerImageId, providerSessionId },
        correlation,
      });
      await this.store.finalization.clearLease(build.id, leaseToken);
      return retrySoon();
    } catch (cleanupError) {
      const quarantined = await this.store.finalization.quarantineArtifact({
        buildId: build.id,
        provider: build.provider,
        providerSessionId,
        completionHash: build.completion_hash!,
        providerImageId,
        error: `Ambiguous artifact persistence after ${errorMessage(
          persistenceError
        )}; compensation failed: ${errorMessage(cleanupError)}`,
      });
      if (quarantined) return completed();
      throw cleanupError;
    }
  }

  /**
   * Runs one bounded provider attempt, handing the adapter the operation a
   * previous delivery reserved and a lease-fenced way to reserve one.
   *
   * A timed-out attempt is ambiguous only while no operation is recorded: once
   * one is — whether by an earlier delivery or by this attempt, moments before
   * the request went out — the outcome is reconcilable by name, and reporting
   * it as pending is what stops a duplicate capture and a failed build.
   */
  private async finalizeWithDeadline(
    adapter: ImageBuildAdapter,
    build: ImageBuildFinalizationRow,
    leaseToken: string,
    context: {
      completionHash: string;
      providerSessionId: string;
      correlation: CorrelationContext;
    }
  ) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_BUILD_PROVIDER_ATTEMPT_MS);
    let reconcilable = Boolean(build.provider_operation_ref);
    try {
      return await adapter.finalizeSuccessfulBuild({
        buildId: build.id,
        providerSessionId: context.providerSessionId,
        correlation: context.correlation,
        signal: controller.signal,
        operation: build.provider_operation_ref
          ? {
              ref: build.provider_operation_ref,
              // Written with the reference in one statement. A reference
              // without one is treated as already exhausted rather than as an
              // unlimited budget.
              deadlineAt: build.provider_operation_deadline_at ?? 0,
            }
          : null,
        reserveOperation: async (ref, deadlineAt) => {
          const reserved = await this.store.finalization.reserveProviderOperation({
            buildId: build.id,
            provider: build.provider,
            providerSessionId: context.providerSessionId,
            completionHash: context.completionHash,
            leaseToken,
            ref,
            deadlineAt,
          });
          if (reserved) reconcilable = true;
          return reserved;
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ImageBuildFinalizationAttemptError(
          "Image build provider finalization attempt timed out",
          reconcilable ? "pending" : "ambiguous",
          { cause: error }
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Marks the leased build failed, then runs terminal cleanup on the failed row. */
  private async failAndCleanup(
    params: { buildId: string; leaseToken: string; error: string },
    correlation: CorrelationContext
  ): Promise<ImageBuildFinalizationResult> {
    await this.store.finalization.markFailed(params);
    const failed = await this.store.finalization.getBuild(params.buildId);
    if (failed) await this.cleanupTerminalBuild(failed, correlation);
    return completed();
  }

  private async cleanupTerminalBuild(
    build: ImageBuildFinalizationRow,
    correlation: CorrelationContext
  ): Promise<void> {
    await this.sessionCleanup.run(build, correlation);
  }
}
