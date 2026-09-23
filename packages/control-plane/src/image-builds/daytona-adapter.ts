import { BUILD_EXPIRES_AT_LABEL, type DaytonaImageBuildResources } from "./daytona-build-resources";
import {
  DaytonaApiError,
  DaytonaCancelledError,
  daytonaBuildResourceName,
  delayUnlessCancelled,
  parseDaytonaSnapshotState,
  type DaytonaSandboxResponse,
  type DaytonaSnapshotResponse,
  type DaytonaSnapshotState,
} from "../sandbox/daytona-rest-client";
import type { ImageBuildProviderImageRef } from "./model";
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
  RecoverUnboundSourceInput,
} from "./types";
import {
  IMAGE_BUILD_FINALIZATION_GRACE_MS,
  resolveImageBuildProviderSessionTimeoutSeconds,
} from "./timeouts";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import { SandboxProviderError } from "../sandbox/provider";

const MS_PER_SECOND = 1000;

/**
 * Headroom between a capture's deadline and the expiry of the source it
 * reads, so the operation is abandoned while there is still time to clean up
 * rather than at the moment the source disappears.
 */
const CAPTURE_DEADLINE_HEADROOM_MS = 60_000;

/** How long one finalization attempt watches the capture it submitted. */
const CAPTURE_OBSERVATION_MS = 90_000;

const CAPTURE_POLL_INTERVAL_MS = 3_000;

/**
 * Snapshot states a capture has stopped moving out of: a complete artifact or
 * a failed one. Anything else is still being produced, including a state this
 * version of the API does not name.
 */
const SETTLED_SNAPSHOT_STATES: ReadonlySet<DaytonaSnapshotState> = new Set([
  "active",
  "inactive",
  "error",
  "build_failed",
  "removing",
]);

/**
 * Daytona adapter for provider-session image builds.
 *
 * Daytona is the first provider whose artifact operation outlives the call
 * that starts it. Capture requires a STOPPED source, the request answers with
 * the source rather than the snapshot, and the snapshot record can stay
 * absent for a while after acceptance — so acceptance proves nothing, and
 * asking again could produce a second artifact.
 *
 * Finalization is therefore resumable rather than single-shot. Each delivery
 * does the next step it can prove is safe: stop the source and wait for it;
 * reserve the snapshot's unique name under the build's lease; submit the
 * capture; then reconcile that name until the snapshot is complete, failed,
 * or past the operation's fixed deadline. A delivery that finds a reservation
 * already recorded ONLY reconciles it.
 *
 * Ownership is checked before anything destructive: a snapshot found under a
 * reserved name belongs to this build only if it names the bound source
 * sandbox as the one it was captured from. Ownership that cannot be
 * established either way settles nothing and adopts nothing.
 */
export class DaytonaImageBuildAdapter implements ImageBuildAdapter {
  constructor(private readonly resources: DaytonaImageBuildResources) {}

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
      onProviderSessionCreated: callbacks.bindProviderSession,
      correlation: plan.correlation,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeImageBuildInput
  ): Promise<ImageBuildProviderImageRef> {
    // A recorded operation is the only thing this delivery may act on: the
    // capture may already be running, and a second request could leak a
    // second snapshot.
    if (input.operation) {
      return await this.awaitCapturedSnapshot(input, input.operation);
    }
    return await this.submitCapture(input);
  }

  async cleanupCompletedBuild(input: CompletedImageBuildInput): Promise<void> {
    await this.resources.deleteBuildSandbox(input.providerSessionId, input.buildId, input.signal);
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.resources.deleteBuildSandbox(input.providerSessionId, input.buildId, input.signal);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.resources.deleteProviderImage(input.image.providerImageId, input.signal);
  }

  async recoverUnboundSource(
    input: RecoverUnboundSourceInput
  ): Promise<{ providerSessionId: string } | null> {
    const sandbox = await this.resources.findBuildSandboxByName(input.buildId, input.signal);
    return sandbox ? { providerSessionId: sandbox.id } : null;
  }

  async reconcileOrphanOperation(
    input: ReconcileOrphanOperationInput
  ): Promise<ReconcileOrphanOperationOutcome> {
    const snapshot = await this.resources.getBuildSnapshot(input.operationRef, input.signal);
    if (!snapshot) return { type: "absent" };
    const ownership = captureOwnership(snapshot.sourceSandboxId, input.providerSessionId);
    // A snapshot under our reserved name that names another source is not
    // ours, and deleting it would destroy someone else's artifact.
    if (ownership === "another") return { type: "absent" };
    // Nothing to compare it against. Settling here would drop the only record
    // of a snapshot that may well be this build's, so the obligation is kept
    // for a pass that can decide.
    if (ownership === "unknown") return { type: "pending" };

    const state = parseDaytonaSnapshotState(snapshot.state);
    if (state === "removing") return { type: "pending" };
    if (
      state === "active" ||
      state === "inactive" ||
      state === "error" ||
      state === "build_failed"
    ) {
      await this.resources.deleteProviderImage(snapshot.id, input.signal);
      return { type: "deleted" };
    }
    // Still being produced: an artifact that becomes visible after this pass
    // is exactly what the retained obligation is for.
    return { type: "pending" };
  }

  /**
   * First delivery for a build: bring the source to a stop, reserve the
   * capture's name, and submit it.
   *
   * The reservation is what authorizes the request, so nothing is submitted
   * without one. A stop that has not finished is reported as pending rather
   * than forced: Daytona captures a stopped container, and a capture issued
   * against a stopping one is not a capture at all.
   */
  private async submitCapture(input: FinalizeImageBuildInput): Promise<ImageBuildProviderImageRef> {
    // Reads the source's labels before anything destructive: ownership, and
    // the expiry that bounds how long the capture may be waited for.
    let source: DaytonaSandboxResponse | null;
    try {
      source = await this.resources.getBuildSandbox(
        input.providerSessionId,
        input.buildId,
        input.signal
      );
    } catch (error) {
      // This is a read before the capture is reserved or submitted. A
      // transient failure cannot have created an artifact, so a later
      // delivery may safely retry instead of failing and deleting the source.
      if (!isDaytonaUnavailable(error)) throw error;
      throw new ImageBuildFinalizationAttemptError(
        "Daytona build sandbox is temporarily unavailable",
        "definitely_not_created",
        { cause: error }
      );
    }
    if (!source) {
      throw new Error("Daytona build sandbox no longer exists");
    }

    if (
      (await this.resources.stopBuildSandboxForCapture(input.providerSessionId, input.signal)) !==
      "stopped"
    ) {
      throw new ImageBuildFinalizationAttemptError(
        "Daytona build sandbox is still stopping",
        "pending"
      );
    }

    const now = Date.now();
    const deadlineAt = captureDeadline(now, source);
    if (deadlineAt <= now) {
      // Reserving here would submit a capture and abandon it on the same
      // pass, leaving a request running against a source about to expire and
      // an obligation nothing can settle until that lifetime is up. A build
      // that ran this close to its source's expiry has simply run out of
      // time.
      throw new Error("Daytona build source expires before its capture could settle");
    }

    const operation: ImageBuildProviderOperation = {
      ref: await daytonaBuildResourceName("image", input.buildId),
      deadlineAt,
    };
    if (!(await input.reserveOperation(operation.ref, operation.deadlineAt))) {
      throw new ImageBuildFinalizationAttemptError(
        "Another delivery holds this build's capture reservation",
        "pending"
      );
    }

    try {
      await this.resources.captureBuildSnapshot(
        input.providerSessionId,
        operation.ref,
        input.signal
      );
    } catch (error) {
      // Once the name is reserved, a request that may have reached Daytona
      // must be reconciled under that name. Reissuing it could create a
      // second capture, while failing the build would delete the source of a
      // capture that may still be running.
      if (!isDaytonaAmbiguousTransportFailure(error)) throw error;
    }
    return await this.awaitCapturedSnapshot(input, operation);
  }

  /**
   * Poll the reserved name until it names a completed snapshot this build owns.
   *
   * `active` and `inactive` are both completed artifacts: an inactive
   * snapshot is cold storage, which the spawn path activates under its own
   * budget before it uses the image. Finalization records it and stops.
   *
   * Absence is not failure: the snapshot record can appear well after the
   * capture is accepted, and so can the provenance that names the source it
   * was captured from. A record that is still being produced without one is
   * watched exactly like a record that has not appeared at all. It becomes
   * failure only once the operation's own deadline has passed — the point
   * past which the source it reads may no longer exist. The deadline is the
   * row's, fixed when the reservation was taken, so redeliveries cannot
   * extend it.
   *
   * What is never waited out is a settled capture this build cannot claim: a
   * record naming another source, or one that stopped moving without naming
   * any.
   */
  private async awaitCapturedSnapshot(
    input: FinalizeImageBuildInput,
    operation: ImageBuildProviderOperation
  ): Promise<ImageBuildProviderImageRef> {
    const attemptDeadline = Date.now() + CAPTURE_OBSERVATION_MS;
    for (;;) {
      let snapshot: DaytonaSnapshotResponse | null;
      try {
        snapshot = await this.resources.getBuildSnapshot(operation.ref, input.signal);
      } catch (error) {
        // An unreachable provider says nothing about the reserved artifact.
        // Keep the fixed operation deadline and let a later read decide.
        if (!isDaytonaUnavailable(error)) throw error;
        snapshot = null;
      }
      const state = snapshot ? parseDaytonaSnapshotState(snapshot.state) : null;
      if (snapshot) {
        const ownership = captureOwnership(snapshot.sourceSandboxId, input.providerSessionId);
        if (ownership === "another") {
          throw new Error("Daytona snapshot under this build's reserved name has another source");
        }
        if (ownership === "ours") {
          if (state === "active" || state === "inactive") {
            return { providerImageId: snapshot.id, providerSessionId: input.providerSessionId };
          }
          if (state === "error" || state === "build_failed" || state === "removing") {
            throw new Error(`Daytona snapshot capture ended as ${state}`);
          }
        } else if (state !== null && SETTLED_SNAPSHOT_STATES.has(state)) {
          // A capture that has stopped moving and still names no source is
          // one this build can never claim. Until then the record is only
          // incomplete, and is waited for like one that has not appeared.
          throw new Error(
            "Daytona snapshot under this build's reserved name has no provable source"
          );
        }
      }

      const now = Date.now();
      if (now >= operation.deadlineAt) {
        // The operation stays recorded on the row: a snapshot that becomes
        // visible after this is maintenance's to reclaim.
        throw new ImageBuildFinalizationAttemptError(
          "Daytona snapshot capture deadline exhausted",
          "ambiguous"
        );
      }
      if (now >= attemptDeadline) {
        throw new ImageBuildFinalizationAttemptError(
          `Daytona snapshot capture is still ${state ?? "unpublished"}`,
          "pending"
        );
      }
      await delayUnlessCancelled(CAPTURE_POLL_INTERVAL_MS, input.signal);
    }
  }
}

/**
 * When this build's capture must have settled.
 *
 * Bounded by the source's own expiry with cleanup headroom, because the
 * source is what a capture reads: waiting past its lifetime cannot produce an
 * artifact, only a stuck row. A source that reports no expiry falls back to
 * the shared finalization budget.
 */
function captureDeadline(now: number, source: DaytonaSandboxResponse): number {
  const graceDeadline = now + IMAGE_BUILD_FINALIZATION_GRACE_MS;
  const expiresAt = sourceExpiry(source);
  return expiresAt === null
    ? graceDeadline
    : Math.min(graceDeadline, expiresAt - CAPTURE_DEADLINE_HEADROOM_MS);
}

/**
 * The source's hard expiry: the label this adapter's own create wrote, else
 * whatever the provider reports, else nothing.
 */
function sourceExpiry(source: DaytonaSandboxResponse): number | null {
  const labelled = Number(source.labels?.[BUILD_EXPIRES_AT_LABEL]);
  if (Number.isFinite(labelled) && labelled > 0) return labelled;
  const reported = source.autoDestroyAt ? Date.parse(source.autoDestroyAt) : Number.NaN;
  return Number.isFinite(reported) ? reported : null;
}

/** What a snapshot found under a build's reserved name can be proven to be. */
type CaptureOwnership = "ours" | "another" | "unknown";

/**
 * A capture is this build's only when it names the bound source sandbox.
 *
 * `unknown` is a third answer, not a synonym for either: with no source on
 * the snapshot or no bound sandbox on the row there is nothing to compare, so
 * the artifact can be neither claimed nor disowned. A caller that would
 * settle an obligation must leave it outstanding; a caller that would adopt
 * the artifact must refuse it.
 */
function captureOwnership(
  sourceSandboxId: string | null | undefined,
  providerSessionId: string | null
): CaptureOwnership {
  if (!sourceSandboxId || !providerSessionId) return "unknown";
  return sourceSandboxId === providerSessionId ? "ours" : "another";
}

/** A failed Daytona call that did not establish the requested operation's outcome. */
function isDaytonaUnavailable(error: unknown): boolean {
  if (error instanceof DaytonaApiError && error.status === 429) return true;
  return isDaytonaAmbiguousTransportFailure(error);
}

/** A failed mutation whose response cannot prove whether Daytona applied it. */
function isDaytonaAmbiguousTransportFailure(error: unknown): boolean {
  if (error instanceof DaytonaApiError) return error.status >= 500;
  if (error instanceof DaytonaCancelledError) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return SandboxProviderError.isTransientNetworkError(error);
}
