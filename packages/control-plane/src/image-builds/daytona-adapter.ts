import type { DaytonaSandboxProvider } from "../sandbox/providers/daytona-provider";
import {
  daytonaBuildResourceName,
  delayUnlessCancelled,
  parseDaytonaSnapshotState,
  type DaytonaSandboxResponse,
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

/** Label carrying the wall-clock end of the build source's hard TTL. */
const BUILD_EXPIRES_AT_LABEL = "openinspect_expires_at";

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
 * capture; then reconcile that name until the snapshot is active, failed, or
 * past the operation's fixed deadline. A delivery that finds a reservation
 * already recorded ONLY reconciles it.
 *
 * Ownership is checked before anything destructive: a snapshot found under a
 * reserved name belongs to this build only if it names the bound source
 * sandbox as the one it was captured from.
 */
export class DaytonaImageBuildAdapter implements ImageBuildAdapter {
  constructor(private readonly provider: DaytonaSandboxProvider) {}

  async startBuild(plan: ImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
    await this.provider.triggerImageBuild({
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
    await this.provider.deleteBuildSandbox(input.providerSessionId, input.buildId, input.signal);
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.provider.deleteBuildSandbox(input.providerSessionId, input.buildId, input.signal);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.image.providerImageId, input.signal);
  }

  async recoverUnboundSource(
    input: RecoverUnboundSourceInput
  ): Promise<{ providerSessionId: string } | null> {
    const sandbox = await this.provider.findBuildSandboxByName(input.buildId, input.signal);
    return sandbox ? { providerSessionId: sandbox.id } : null;
  }

  async reconcileOrphanOperation(
    input: ReconcileOrphanOperationInput
  ): Promise<ReconcileOrphanOperationOutcome> {
    const snapshot = await this.provider.getBuildSnapshot(input.operationRef, input.signal);
    if (!snapshot) return { type: "absent" };
    // A snapshot under our reserved name that names another source is not
    // ours, and deleting it would destroy someone else's artifact.
    if (!ownsCapture(snapshot.sourceSandboxId, input.providerSessionId)) {
      return { type: "absent" };
    }

    const state = parseDaytonaSnapshotState(snapshot.state);
    if (state === "removing") return { type: "pending" };
    if (
      state === "active" ||
      state === "inactive" ||
      state === "error" ||
      state === "build_failed"
    ) {
      await this.provider.deleteProviderImage(snapshot.id, input.signal);
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
    const source = await this.provider.getBuildSandbox(
      input.providerSessionId,
      input.buildId,
      input.signal
    );
    if (!source) {
      throw new Error("Daytona build sandbox no longer exists");
    }

    if (
      (await this.provider.stopBuildSandboxForCapture(input.providerSessionId, input.signal)) !==
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

    await this.provider.captureBuildSnapshot(input.providerSessionId, operation.ref, input.signal);
    return await this.awaitCapturedSnapshot(input, operation);
  }

  /**
   * Poll the reserved name until it names an active snapshot this build owns.
   *
   * Absence is not failure: the snapshot record can appear well after the
   * capture is accepted. It becomes failure only once the operation's own
   * deadline has passed — the point past which the source it reads may no
   * longer exist. The deadline is the row's, fixed when the reservation was
   * taken, so redeliveries cannot extend it.
   */
  private async awaitCapturedSnapshot(
    input: FinalizeImageBuildInput,
    operation: ImageBuildProviderOperation
  ): Promise<ImageBuildProviderImageRef> {
    const attemptDeadline = Date.now() + CAPTURE_OBSERVATION_MS;
    for (;;) {
      const snapshot = await this.provider.getBuildSnapshot(operation.ref, input.signal);
      if (snapshot && !ownsCapture(snapshot.sourceSandboxId, input.providerSessionId)) {
        throw new Error("Daytona snapshot under this build's reserved name has another source");
      }
      const state = snapshot ? parseDaytonaSnapshotState(snapshot.state) : null;
      if (snapshot && state === "active") {
        return { providerImageId: snapshot.id, providerSessionId: input.providerSessionId };
      }
      if (state === "error" || state === "build_failed" || state === "removing") {
        throw new Error(`Daytona snapshot capture ended as ${state}`);
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

/** A capture is this build's only when it names the bound source sandbox. */
function ownsCapture(
  sourceSandboxId: string | null | undefined,
  providerSessionId: string | null
): boolean {
  return Boolean(sourceSandboxId) && sourceSandboxId === providerSessionId;
}
