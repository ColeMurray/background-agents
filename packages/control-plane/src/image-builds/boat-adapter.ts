import {
  BoatApiError,
  BoatCancelledError,
  delayUnlessCancelled,
  type BoatSavedSnapshot,
} from "../sandbox/boat-rest-client";
import { SandboxProviderError } from "../sandbox/provider";
import type { BoatBuildSourceStop, BoatImageBuildResources } from "./boat-build-resources";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import type { ImageBuildProviderImageRef } from "./model";
import { resolveImageBuildProviderSessionTimeoutSeconds } from "./timeouts";
import type {
  CompletedImageBuildInput,
  DeleteImageInput,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildPlan,
  ImageBuildProviderOperation,
  ImageBuildStartCallbacks,
  ReconcileOrphanOperationInput,
  ReconcileOrphanOperationOutcome,
} from "./types";

const MS_PER_SECOND = 1000;

/**
 * When a build's save must have settled. The save reads an archived source's
 * last automatic snapshot, which Boat keeps for days, so the bound is the
 * save's own: a fresh capture of a large image can run for minutes.
 */
export const BOAT_IMAGE_SAVE_DEADLINE_MS = 20 * 60 * MS_PER_SECOND;

/** How long one finalization attempt watches a save, and how often it looks. */
export interface BoatImageBuildAdapterTimings {
  /** After this, the attempt reports the save pending and the next delivery takes over. */
  saveObservationMs: number;
  savePollIntervalMs: number;
}

const DEFAULT_BOAT_IMAGE_BUILD_ADAPTER_TIMINGS: BoatImageBuildAdapterTimings = {
  saveObservationMs: 90_000,
  savePollIntervalMs: 5_000,
};

/**
 * Boat adapter for provider-session image builds.
 *
 * A Boat image is a saved snapshot: a full, standalone copy of the build
 * sandbox's disk under a name this deployment derives from the build. The
 * save is asynchronous (`saving` until Boat reports `ready` or `failed`), so
 * finalization is resumable: each delivery archives the source if it is still
 * running, reserves the name under the build's lease, submits the save, and
 * then reconciles that name until the snapshot settles or the operation's
 * fixed deadline passes. A delivery that finds a reservation already
 * recorded only reconciles it.
 *
 * The name is the save's idempotency key. Boat replaces the artifact behind
 * an existing name rather than adding a second one, and refuses a save that
 * overlaps a running one, so a repeated submission can never leak an extra
 * snapshot. That is why a reserved name under which Boat has no record may
 * simply be submitted again, while the operation's deadline allows: the only
 * way to have no record is to have had no accepted request.
 */
export class BoatImageBuildAdapter implements ImageBuildAdapter {
  private readonly timings: BoatImageBuildAdapterTimings;

  constructor(
    private readonly resources: BoatImageBuildResources,
    timings: Partial<BoatImageBuildAdapterTimings> = {}
  ) {
    this.timings = { ...DEFAULT_BOAT_IMAGE_BUILD_ADAPTER_TIMINGS, ...timings };
  }

  async startBuild(plan: ImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
    await this.resources.triggerImageBuild({
      scopeKind: plan.scope.kind,
      scopeId: plan.scope.id,
      repositories: plan.repositories,
      buildId: plan.buildId,
      callbackUrl: plan.callbackUrl,
      failureCallbackUrl: plan.failureCallbackUrl,
      callbackToken: plan.callbackToken,
      userEnvVars: plan.userEnvVars,
      cloneToken: plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.token : undefined,
      buildExecutionTimeoutSeconds: Math.ceil(plan.buildTimeoutMs / MS_PER_SECOND),
      providerSessionTimeoutSeconds: resolveImageBuildProviderSessionTimeoutSeconds(
        plan.buildTimeoutMs
      ),
      // The scope's resource request sizes the build machine as it sizes the
      // session's: setup must not run out of memory on a smaller box.
      resources: plan.resources,
      onProviderSessionCreated: callbacks.bindProviderSession,
      correlation: plan.correlation,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeImageBuildInput
  ): Promise<ImageBuildProviderImageRef> {
    if (input.operation) {
      return await this.awaitSavedSnapshot(input, input.operation, { submitted: false });
    }
    return await this.submitSave(input);
  }

  async cleanupCompletedBuild(input: CompletedImageBuildInput): Promise<void> {
    // The saved snapshot is a standalone copy; the source is not needed again.
    await this.resources.deleteBuildSandbox(input.providerSessionId, input.signal);
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.resources.deleteBuildSandbox(input.providerSessionId, input.signal);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.resources.deleteProviderImage(input.image.providerImageId, input.signal);
  }

  /**
   * A reserved name settles once Boat has nothing under it or its snapshot
   * is gone. A save still running keeps the obligation, and so does a delete
   * Boat refuses while that save runs.
   */
  async reconcileOrphanOperation(
    input: ReconcileOrphanOperationInput
  ): Promise<ReconcileOrphanOperationOutcome> {
    const snapshot = await this.resources.getImageSnapshot(input.operationRef, input.signal);
    if (!snapshot) return { type: "absent" };
    if (snapshot.status === "saving") return { type: "pending" };
    // The name is this deployment's by construction; a record under it that
    // names another source would still be someone else's artifact.
    if (!isSavedFrom(snapshot, input.providerSessionId)) return { type: "absent" };
    try {
      await this.resources.deleteProviderImage(input.operationRef, input.signal);
    } catch (error) {
      if (boatErrorCode(error) === "save_in_progress") return { type: "pending" };
      throw error;
    }
    return { type: "deleted" };
  }

  /**
   * First delivery for a build: archive the source, reserve the image name
   * and submit the save. Nothing is submitted without a reservation, and a
   * source that is still archiving is reported as pending rather than saved
   * mid-stop.
   */
  private async submitSave(input: FinalizeImageBuildInput): Promise<ImageBuildProviderImageRef> {
    let stopped: BoatBuildSourceStop;
    try {
      stopped = await this.resources.stopBuildSandboxForSave(input.providerSessionId, input.signal);
    } catch (error) {
      // Nothing is reserved or submitted yet, so a provider that cannot be
      // reached now has created nothing; a later delivery retries.
      if (!isBoatUnavailable(error)) throw error;
      throw new ImageBuildFinalizationAttemptError(
        "Boat build sandbox is temporarily unavailable",
        "definitely_not_created",
        { cause: error }
      );
    }
    if (stopped === "missing") {
      throw new Error("Boat build sandbox no longer exists");
    }
    if (stopped === "stopping") {
      throw new ImageBuildFinalizationAttemptError(
        "Boat build sandbox is still archiving",
        "pending"
      );
    }

    const operation: ImageBuildProviderOperation = {
      ref: await this.resources.imageSnapshotName(input.buildId),
      deadlineAt: Date.now() + BOAT_IMAGE_SAVE_DEADLINE_MS,
    };
    if (!(await input.reserveOperation(operation.ref, operation.deadlineAt))) {
      throw new ImageBuildFinalizationAttemptError(
        "Another delivery holds this build's save reservation",
        "pending"
      );
    }

    await this.save(input, operation.ref);
    return await this.awaitSavedSnapshot(input, operation, { submitted: true });
  }

  /**
   * Submit the save under the reserved name. A save already running under it
   * is this build's own earlier request, so it counts as submitted; an
   * account that cannot keep another saved snapshot fails the build with the
   * reason an operator can act on.
   */
  private async save(input: FinalizeImageBuildInput, name: string): Promise<void> {
    try {
      await this.resources.saveImageSnapshot(input.providerSessionId, name, input.signal);
    } catch (error) {
      const code = boatErrorCode(error);
      if (code === "save_in_progress") return;
      if (code === "credit_required") {
        throw new Error(
          "Boat refused to save the image: the account is at its saved-snapshot allowance " +
            "and has no money in the Boat wallet. Remove unused saved snapshots or add money " +
            "to the Boat wallet, then rebuild."
        );
      }
      // A request that may have reached Boat is reconciled under the reserved
      // name: the poll either finds the record or submits once more.
      if (isBoatUnavailable(error)) return;
      throw error;
    }
  }

  /**
   * Poll the reserved name until it names a ready snapshot saved from this
   * build's source.
   *
   * No record under a reserved name means no accepted request, so the save
   * is submitted (once per delivery) rather than waited for — unless the
   * operation's fixed deadline has passed, when nothing new may be started
   * for a build that is about to fail. A `failed` record fails the build. The
   * attempt stops watching after its observation window and reports pending,
   * so the lease is released while Boat works; past the deadline the build
   * fails and maintenance reclaims whatever the name later holds. A snapshot
   * that is already ready is adopted whatever the clock says.
   */
  private async awaitSavedSnapshot(
    input: FinalizeImageBuildInput,
    operation: ImageBuildProviderOperation,
    state: { submitted: boolean }
  ): Promise<ImageBuildProviderImageRef> {
    const attemptDeadline = Date.now() + this.timings.saveObservationMs;
    let submitted = state.submitted;
    for (;;) {
      let snapshot: BoatSavedSnapshot | null | undefined;
      try {
        snapshot = await this.resources.getImageSnapshot(operation.ref, input.signal);
      } catch (error) {
        // An unreachable provider says nothing about the reserved artifact;
        // keep the fixed deadline and let a later read decide.
        if (!isBoatUnavailable(error)) throw error;
        snapshot = undefined;
      }

      if (snapshot) {
        if (snapshot.status === "ready") {
          if (!isSavedFrom(snapshot, input.providerSessionId)) {
            throw new Error("Boat snapshot under this build's image name has another source");
          }
          return { providerImageId: operation.ref, providerSessionId: input.providerSessionId };
        }
        if (snapshot.status === "failed") {
          throw new Error(
            `Boat image snapshot save failed${snapshot.error ? `: ${snapshot.error}` : ""}`
          );
        }
      } else if (snapshot === null && !submitted && Date.now() < operation.deadlineAt) {
        submitted = true;
        await this.save(input, operation.ref);
      }

      const now = Date.now();
      if (now >= operation.deadlineAt) {
        // The operation stays recorded on the row: a snapshot that becomes
        // ready after this is maintenance's to reclaim.
        throw new ImageBuildFinalizationAttemptError(
          "Boat image snapshot save deadline exhausted",
          "ambiguous"
        );
      }
      if (now >= attemptDeadline) {
        throw new ImageBuildFinalizationAttemptError(
          `Boat image snapshot save is still ${snapshot?.status ?? "unconfirmed"}`,
          "pending"
        );
      }
      await delayUnlessCancelled(this.timings.savePollIntervalMs, input.signal);
    }
  }
}

/**
 * Whether a snapshot record was saved from the build's bound source. A
 * record that names no source, or a row that has dropped its sandbox,
 * leaves nothing to compare, and the name itself is the deployment's.
 */
function isSavedFrom(snapshot: BoatSavedSnapshot, providerSessionId: string | null): boolean {
  if (!snapshot.sourceSandboxId || !providerSessionId) return true;
  return snapshot.sourceSandboxId === providerSessionId;
}

/** Boat's stable error code behind a failed call, if any. */
function boatErrorCode(error: unknown): string | undefined {
  if (error instanceof BoatApiError) return error.code;
  if (error instanceof SandboxProviderError && error.cause instanceof BoatApiError) {
    return error.cause.code;
  }
  return undefined;
}

/** A failed Boat call that did not establish the requested operation's outcome. */
function isBoatUnavailable(error: unknown): boolean {
  if (error instanceof SandboxProviderError) return error.errorType === "transient";
  if (error instanceof BoatApiError) return error.status === 429 || error.status >= 500;
  if (error instanceof BoatCancelledError) return true;
  return SandboxProviderError.isTransientNetworkError(error);
}
