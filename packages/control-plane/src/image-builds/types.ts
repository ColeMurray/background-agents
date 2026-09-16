import type { RepositoryShaEntry } from "@open-inspect/shared/types/image-builds";
import type { CorrelationContext } from "../logger";
import type { ImageBuildProviderImageRef, ImageBuildScope } from "./model";

export type ImageBuildWorkflowContext = CorrelationContext;

/** One repository of a build scope, in position order ([0] = primary). */
export interface ImageBuildRepository {
  repoOwner: string;
  repoName: string;
  baseBranch: string;
}

/**
 * Triggering is idempotent under the per-scope concurrency rule: a second
 * trigger while a build is in flight reports the existing build instead of
 * stacking another. `up_to_date` is returned only by the save-hook variant,
 * when a ready image already matches the current repository set.
 */
export type TriggerImageBuildResult =
  | { type: "triggered"; buildId: string }
  | { type: "already_building"; buildId: string }
  | { type: "up_to_date" };

/** Clone auth handed to provider-session build sandboxes (provider-policy.ts). */
export type ImageBuildCloneAuth =
  | { type: "credential_helper"; host: string; username: string; token: string }
  | { type: "unavailable" };

/**
 * Provider-neutral build request resolved before adapter-specific execution.
 * Every supported provider uses the same create-bind-launch session contract.
 */
export interface ImageBuildPlan {
  buildId: string;
  scope: ImageBuildScope;
  repositories: ImageBuildRepository[];
  repositoriesFingerprint: string;
  callbackUrl: string;
  /**
   * Failure callback URL, sent explicitly alongside callbackUrl so the build
   * worker never derives it from the success route's path (routes on either
   * plane can be renamed without silently pointing failures at a 404).
   */
  failureCallbackUrl: string;
  /** User-configured build-execution budget; provider sessions add finalization headroom. */
  buildTimeoutMs: number;
  userEnvVars?: Record<string, string>;
  correlation: CorrelationContext;
  callbackToken: string;
  cloneAuth: ImageBuildCloneAuth;
}

/** Lets provider-session adapters bind the provider sandbox id before the runtime launches. */
export interface ImageBuildStartCallbacks {
  bindProviderSession(providerSessionId: string): Promise<void>;
}

/**
 * Wire form of the build-complete callback after route-level parsing.
 * repository_shas and runtime_version are reported by the build itself —
 * the route fails closed (400) when either is missing or unparseable, because
 * an unversioned image must never pass the floor check.
 */
export interface CompleteImageBuildCallback {
  buildId: string;
  providerSessionId: string;
  repositoryShas: RepositoryShaEntry[];
  runtimeVersion: string;
  /** Wire seconds passed through unconverted — the D1 column is also seconds. */
  buildDurationSeconds: number;
}

export interface FailImageBuildCallback {
  buildId: string;
  providerSessionId: string;
  errorMessage: string;
}

export interface DeleteImageInput {
  image: ImageBuildProviderImageRef;
  correlation?: CorrelationContext;
  signal?: AbortSignal;
}

/** A provider artifact operation already reserved for this build. */
export interface ImageBuildProviderOperation {
  /** The unique provider name the operation was submitted under. */
  ref: string;
  /** Fixed wall-clock deadline (ms) by which it must settle; never extended. */
  deadlineAt: number;
}

/** Teardown input for a build whose artifact is already recorded. */
export interface CompletedImageBuildInput {
  buildId: string;
  providerSessionId: string;
  correlation: CorrelationContext;
  signal?: AbortSignal;
}

/** Finalization input for provider-session builds (the deferred snapshot/checkpoint). */
export interface FinalizeImageBuildInput extends CompletedImageBuildInput {
  /**
   * The operation a previous delivery reserved, or null when none has been.
   * An adapter that reads this must reconcile that exact operation instead of
   * submitting another; adapters whose provider returns a finished artifact
   * from one call ignore it.
   */
  operation: ImageBuildProviderOperation | null;
  /**
   * Reserves the name an asynchronous operation will be submitted under,
   * before submitting it. False means another delivery holds the reservation
   * or the build moved on, and the caller must not submit anything.
   */
  reserveOperation(ref: string, deadlineAt: number): Promise<boolean>;
}

/** Input for reconciling an operation whose build is already terminal. */
export interface ReconcileOrphanOperationInput {
  buildId: string;
  /** The reserved provider name to reconcile. */
  operationRef: string;
  /** The source sandbox that owns it; null once the row has dropped it. */
  providerSessionId: string | null;
  correlation: CorrelationContext;
  signal?: AbortSignal;
}

/**
 * What became of an orphaned operation. `absent` and `deleted` both settle
 * the obligation; `pending` keeps it, so the next pass tries again rather
 * than losing a resource nothing else records.
 */
export type ReconcileOrphanOperationOutcome =
  | { type: "absent" }
  | { type: "deleted" }
  | { type: "pending" };

/** Input for finding a build source whose create response was never seen. */
export interface RecoverUnboundSourceInput {
  buildId: string;
  correlation: CorrelationContext;
  signal?: AbortSignal;
}

export interface FailedImageBuildInput {
  buildId: string;
  providerSessionId: string;
  errorMessage: string;
  correlation: CorrelationContext;
  signal?: AbortSignal;
}

/**
 * Provider-facing operations for image builds. The workflow owns state
 * transitions; adapters own translating lifecycle steps into provider API
 * calls (start build, snapshot/checkpoint, teardown, artifact deletion).
 * Every supported provider follows the same provider-session lifecycle.
 */
export type ImageBuildAdapter = {
  startBuild(plan: ImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void>;
  deleteImage(input: DeleteImageInput): Promise<void>;
  finalizeSuccessfulBuild(input: FinalizeImageBuildInput): Promise<ImageBuildProviderImageRef>;
  cleanupFailedBuild(input: FailedImageBuildInput): Promise<void>;
  cleanupCompletedBuild(input: CompletedImageBuildInput): Promise<void>;
  /**
   * Finds a build source by the name reserved for it, for a create whose
   * response never arrived. Null means the provider has no such sandbox.
   *
   * Implementing this is also what tells the workflow to record a create
   * intent before creating: only a provider whose sources can be found again
   * by name has anything to recover, and only then is the intent a handle
   * rather than a row that can never be settled.
   */
  recoverUnboundSource?(input: RecoverUnboundSourceInput): Promise<{
    providerSessionId: string;
  } | null>;
  /**
   * Settles an artifact operation left behind by a build that failed or was
   * superseded: reclaim what the reserved name produced, or report that it
   * produced nothing.
   */
  reconcileOrphanOperation?(
    input: ReconcileOrphanOperationInput
  ): Promise<ReconcileOrphanOperationOutcome>;
};
