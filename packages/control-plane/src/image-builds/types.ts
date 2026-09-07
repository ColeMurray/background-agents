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

/** Finalization input for provider-session builds (the deferred snapshot/checkpoint). */
export interface FinalizeImageBuildInput {
  buildId: string;
  providerSessionId: string;
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
  cleanupCompletedBuild(input: FinalizeImageBuildInput): Promise<void>;
};
