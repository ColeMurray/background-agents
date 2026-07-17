import type { RepositoryShaEntry } from "@open-inspect/shared";
import type { CorrelationContext } from "../logger";
import type { ImageBuildProviderImageRef, ImageBuildScope, SupersededImageBuild } from "./model";

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

export type ImageBuildWorkflowResult =
  | { type: "completion_accepted"; finalization: Promise<void> }
  | {
      type: "build_ready";
      replacedImages: SupersededImageBuild[];
      cleanup?: Promise<void>;
    }
  | { type: "build_superseded"; cleanup?: Promise<void> }
  | { type: "build_failed"; cleanup?: Promise<void> };

/** Provider-neutral build request fields resolved before adapter-specific execution. */
interface BaseImageBuildPlan {
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
  buildTimeoutMs: number;
  userEnvVars?: Record<string, string>;
  correlation: CorrelationContext;
}

/** Modal's data-plane builder returns the provider image id directly in its callback. */
export interface ModalImageBuildPlan extends BaseImageBuildPlan {
  provider: "modal";
  callbackMode: "provider_image";
}

/** Clone auth handed to provider-session build sandboxes (provider-policy.ts). */
export type ImageBuildCloneAuth =
  | { type: "credential_helper"; token: string }
  | { type: "unavailable" };

/** Vercel builds inside a sandbox; the control plane snapshots it after callback success. */
export interface VercelImageBuildPlan extends BaseImageBuildPlan {
  provider: "vercel";
  callbackMode: "provider_session";
  callbackToken: string;
  cloneAuth: ImageBuildCloneAuth;
}

/** OpenComputer builds inside a sandbox; the control plane checkpoints it after callback success. */
export interface OpenComputerImageBuildPlan extends BaseImageBuildPlan {
  provider: "opencomputer";
  callbackMode: "provider_session";
  callbackToken: string;
  cloneAuth: ImageBuildCloneAuth;
}

export type ImageBuildPlan =
  | ModalImageBuildPlan
  | VercelImageBuildPlan
  | OpenComputerImageBuildPlan;

export type PlannedImageBuild =
  | { plan: ModalImageBuildPlan; callbackAuth: { type: "none" } }
  | {
      plan: VercelImageBuildPlan;
      callbackAuth: { type: "bearer_token"; tokenHash: string; expiresAt: number };
    }
  | {
      plan: OpenComputerImageBuildPlan;
      callbackAuth: { type: "bearer_token"; tokenHash: string; expiresAt: number };
    };

/** Lets provider-session adapters bind the provider sandbox id before the runtime launches. */
export interface ImageBuildStartCallbacks {
  /**
   * `providerSecretStoreId` records a per-build secret store the provider
   * created for the build sandbox (OpenComputer), so the reaper can delete it
   * with the image. Providers without one omit it.
   */
  bindProviderSession(
    providerSessionId: string,
    providerSecretStoreId?: string | null
  ): Promise<void>;
}

/**
 * Wire form of the build-complete callback after route-level parsing.
 * repository_shas and runtime_version are reported by the build itself —
 * registration fails closed when either is missing or unparseable, because an
 * unversioned image must never pass the floor check.
 */
export interface CompleteImageBuildCallback {
  buildId: string;
  providerImageId?: string;
  providerSessionId?: string;
  repositoryShas?: RepositoryShaEntry[];
  runtimeVersion?: string;
  buildDurationMs?: number;
}

export interface FailImageBuildCallback {
  buildId: string;
  providerSessionId?: string;
  errorMessage: string;
}

export interface DeleteImageInput {
  image: ImageBuildProviderImageRef;
  correlation?: CorrelationContext;
}

/** Finalization input for provider-session builds (the deferred snapshot/checkpoint). */
export interface FinalizeImageBuildInput {
  buildId: string;
  providerSessionId: string;
  correlation: CorrelationContext;
}

export interface FailedImageBuildInput {
  buildId: string;
  providerSessionId: string;
  errorMessage: string;
  correlation: CorrelationContext;
}

/**
 * Teardown input for a build sandbox whose completion already settled.
 * `keepSecretStore` is the workflow's judgement about whether a durable image
 * now depends on the build's secret store: true only when the build was marked
 * ready (its checkpoint retains the store as a base layer, so it must outlive
 * the sandbox and be reaped with the image); false when the checkpoint was
 * discarded (superseded, or the commit never settled), so the store is deleted
 * with the sandbox. Providers without per-build secret stores ignore it.
 */
export interface CleanupCompletedBuildInput extends FinalizeImageBuildInput {
  keepSecretStore: boolean;
}

/**
 * Provider-facing operations for image builds. The workflow owns state
 * transitions; adapters own translating lifecycle steps into provider API
 * calls (start build, snapshot/checkpoint, teardown, artifact deletion).
 * The finalize/cleanup hooks apply to provider_session builds only — Modal's
 * callback already carries the artifact id.
 */
export type ImageBuildAdapter<Plan extends ImageBuildPlan> = {
  startBuild(plan: Plan, callbacks: ImageBuildStartCallbacks): Promise<void>;
  deleteImage(input: DeleteImageInput): Promise<void>;
  finalizeSuccessfulBuild?(input: FinalizeImageBuildInput): Promise<ImageBuildProviderImageRef>;
  cleanupFailedBuild?(input: FailedImageBuildInput): Promise<void>;
  cleanupCompletedBuild?(input: CleanupCompletedBuildInput): Promise<void>;
};

export type AnyImageBuildAdapter =
  | ImageBuildAdapter<ModalImageBuildPlan>
  | ImageBuildAdapter<VercelImageBuildPlan>
  | ImageBuildAdapter<OpenComputerImageBuildPlan>;
