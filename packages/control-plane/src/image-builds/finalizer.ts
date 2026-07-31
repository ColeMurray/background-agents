import { generateId } from "../auth/crypto";
import type { ImageBuildFinalizationRow } from "../db/image-build-finalization";
import type { ImageBuildStore } from "../db/image-builds";
import type { CorrelationContext } from "../logger";
import type { ImageBuildFinalizationJob } from "./finalization-job";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import { ImageBuildReaper } from "./reaper";
import { ImageBuildSessionCleanup } from "./session-cleanup";
import type { ImageBuildAdapter } from "./types";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";

export { ImageBuildFinalizationAttemptError } from "./finalization-error";

/** Lease exceeds the provider deadline so overlapping creation attempts cannot run. */
export const IMAGE_BUILD_FINALIZATION_LEASE_MS = 6 * 60 * 1000;

/** Hard deadline for one provider snapshot or checkpoint attempt. */
export const IMAGE_BUILD_PROVIDER_ATTEMPT_MS = 5 * 60 * 1000;
export const IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS = 15;
const LEASE_EXPIRY_HEADROOM_SECONDS = 5;

/** Queue disposition returned after processing one finalization command. */
export type ImageBuildFinalizationResult =
  | { type: "completed" }
  | { type: "retry"; delaySeconds: number };

const completed = (): ImageBuildFinalizationResult => ({ type: "completed" });
const retrySoon = (): ImageBuildFinalizationResult => ({
  type: "retry",
  delaySeconds: IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS,
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
        IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS * 1000,
        (current?.finalization_lease_expires_at ?? now) - now
      );
      return {
        type: "retry",
        delaySeconds: Math.ceil(delayMs / 1000) + LEASE_EXPIRY_HEADROOM_SECONDS,
      };
    }

    build = await this.store.finalization.getBuild(build.id);
    if (!build || build.finalization_lease_token !== leaseToken || !build.provider_session_id) {
      return retrySoon();
    }

    if (expiredAttemptWithoutArtifact && !build.provider_image_id) {
      await this.store.finalization.markFailed({
        buildId: build.id,
        leaseToken,
        error: "Previous provider finalization attempt outcome unknown after lease expiry",
      });
      const failed = await this.store.finalization.getBuild(build.id);
      if (failed) await this.cleanupTerminalBuild(failed, correlation);
      return completed();
    }

    const adapter = this.adapterFactory.create(build.provider, "existing_session");
    let providerImageId = build.provider_image_id;
    if (!providerImageId) {
      try {
        const image = await this.finalizeWithDeadline(
          adapter,
          build.id,
          build.provider_session_id,
          correlation
        );
        providerImageId = image.providerImageId;
      } catch (error) {
        if (
          error instanceof ImageBuildFinalizationAttemptError &&
          error.outcome === "definitely_not_created"
        ) {
          await this.store.finalization.clearLease(build.id, leaseToken);
          return retrySoon();
        }
        const message =
          error instanceof ImageBuildFinalizationAttemptError && error.outcome === "ambiguous"
            ? `Provider finalization outcome unknown: ${errorMessage(error)}`
            : errorMessage(error);
        await this.store.finalization.markFailed({
          buildId: build.id,
          leaseToken,
          error: message,
        });
        const failed = await this.store.finalization.getBuild(build.id);
        if (failed) await this.cleanupTerminalBuild(failed, correlation);
        return completed();
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

    const repositoryShas = parseRepositoryShas(build.repository_shas);
    const ready = await this.store.tryMarkImageBuildReady(
      build.id,
      build.provider,
      providerImageId,
      repositoryShas,
      build.runtime_version,
      (build.build_duration_seconds ?? 0) * 1000,
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

  private async finalizeWithDeadline(
    adapter: ImageBuildAdapter,
    buildId: string,
    providerSessionId: string,
    correlation: CorrelationContext
  ) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_BUILD_PROVIDER_ATTEMPT_MS);
    try {
      return await adapter.finalizeSuccessfulBuild({
        buildId,
        providerSessionId,
        correlation,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ImageBuildFinalizationAttemptError(
          "Image build provider finalization attempt timed out",
          "ambiguous",
          { cause: error }
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async cleanupTerminalBuild(
    build: ImageBuildFinalizationRow,
    correlation: CorrelationContext
  ): Promise<void> {
    await this.sessionCleanup.run(build, correlation);
  }
}

function parseRepositoryShas(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Stored repository_shas is not an array");
  return parsed as Array<{ repoOwner: string; repoName: string; baseSha: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
