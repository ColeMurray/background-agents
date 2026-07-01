import type { CorrelationContext } from "../logger";
import type { RepoImageProviderImageRef, SupersededRepoImage } from "./model";

/**
 * Callback mode captures the lifecycle shape, not the vendor.
 *
 * provider_image: the builder callback includes the ready artifact id.
 * provider_session: the callback identifies a build sandbox; the control plane
 * then snapshots/checkpoints that sandbox into the repo image artifact.
 */
export type RepoImageCallbackMode = "provider_image" | "provider_session";
export type RepoImageWorkflowContext = CorrelationContext;

export type ReplacedRepoImage = SupersededRepoImage;

export interface TriggerRepoImageBuildResult {
  buildId: string;
}

export type RepoImageWorkflowResult =
  | { type: "completion_accepted"; finalization: Promise<void> }
  | { type: "build_ready"; replacedImages: ReplacedRepoImage[]; cleanup?: Promise<void> }
  | { type: "build_superseded"; cleanup?: Promise<void> }
  | { type: "build_failed"; cleanup?: Promise<void> };

/** Provider-neutral build request fields resolved before adapter-specific execution. */
interface BaseRepoImageBuildPlan {
  buildId: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  callbackUrl: string;
  buildTimeoutMs: number;
  userEnvVars?: Record<string, string>;
  correlation: CorrelationContext;
}

/** Modal's data-plane builder returns the provider image id directly in its callback. */
export interface ModalRepoImageBuildPlan extends BaseRepoImageBuildPlan {
  provider: "modal";
  callbackMode: "provider_image";
}

export type VercelCloneAuth =
  | { type: "credential_helper"; token: string }
  | { type: "unavailable" };

/** Vercel builds inside a sandbox; the control plane snapshots it after callback success. */
export interface VercelRepoImageBuildPlan extends BaseRepoImageBuildPlan {
  provider: "vercel";
  callbackMode: "provider_session";
  callbackToken: string;
  cloneAuth: VercelCloneAuth;
}

/** OpenComputer builds inside a sandbox; the control plane checkpoints it after callback success. */
export interface OpenComputerRepoImageBuildPlan extends BaseRepoImageBuildPlan {
  provider: "opencomputer";
  callbackMode: "provider_session";
  callbackToken: string;
}

export type ProviderSessionRepoImageBuildPlan =
  | VercelRepoImageBuildPlan
  | OpenComputerRepoImageBuildPlan;

export type RepoImageBuildPlan =
  | ModalRepoImageBuildPlan
  | VercelRepoImageBuildPlan
  | OpenComputerRepoImageBuildPlan;

export type RepoImageCallbackAuth =
  | { type: "none" }
  | { type: "bearer_token"; tokenHash: string; expiresAt: number };

/**
 * Planner output keeps the provider-specific plan and its persisted callback auth together.
 * This is the handoff from environment/repository resolution to workflow execution.
 */
export type PlannedRepoImageBuild =
  | { plan: ModalRepoImageBuildPlan; callbackAuth: { type: "none" } }
  | {
      plan: VercelRepoImageBuildPlan;
      callbackAuth: Extract<RepoImageCallbackAuth, { type: "bearer_token" }>;
    }
  | {
      plan: OpenComputerRepoImageBuildPlan;
      callbackAuth: Extract<RepoImageCallbackAuth, { type: "bearer_token" }>;
    };

/** Lets provider-session adapters bind the provider sandbox id before the runtime launches. */
export interface RepoImageBuildStartCallbacks {
  bindProviderSession(providerSessionId: string): Promise<void>;
}

export interface CompleteProviderImageBuild {
  kind: "provider_image";
  buildId: string;
  providerImageId: string;
  baseSha: string;
  buildDurationMs: number;
}

export interface CompleteProviderSessionBuild {
  kind: "provider_session";
  buildId: string;
  providerSessionId: string;
  baseSha: string;
  buildDurationMs: number;
}

export type CompleteRepoImageBuild = CompleteProviderImageBuild | CompleteProviderSessionBuild;

export interface CompleteRepoImageBuildCallback {
  buildId: string;
  providerImageId?: string;
  providerSessionId?: string;
  baseSha?: string;
  buildDurationMs?: number;
}

export type FinalizeRepoImageBuildInput = CompleteRepoImageBuild & {
  correlation: CorrelationContext;
};

export type FinalizeRepoImageBuildResult = RepoImageProviderImageRef;

export interface FailProviderImageBuild {
  kind: "provider_image";
  buildId: string;
  errorMessage: string;
}

export interface FailProviderSessionBuild {
  kind: "provider_session";
  buildId: string;
  providerSessionId: string;
  errorMessage: string;
}

export type FailRepoImageBuild = FailProviderImageBuild | FailProviderSessionBuild;

export interface FailRepoImageBuildCallback {
  buildId: string;
  providerSessionId?: string;
  errorMessage: string;
}

export type FailedRepoImageBuildInput = FailRepoImageBuild & {
  correlation: CorrelationContext;
};

/** Cleanup hook for providers whose completed build sandbox outlives finalization. */
export interface CleanupCompletedProviderSessionBuildInput {
  kind: "provider_session";
  buildId: string;
  providerSessionId: string;
  correlation: CorrelationContext;
}

export interface DeleteRepoImageInput {
  image: RepoImageProviderImageRef;
  correlation?: CorrelationContext;
}

/**
 * Provider-facing operations needed after a build has started.
 *
 * The workflow owns state transitions; adapters own translating lifecycle steps
 * into provider API calls such as snapshot/checkpoint, stop/delete, and artifact deletion.
 */
export interface RepoImageBuildFinalizer {
  finalizeSuccessfulBuild(
    input: FinalizeRepoImageBuildInput
  ): Promise<FinalizeRepoImageBuildResult>;

  cleanupFailedBuild?(input: FailedRepoImageBuildInput): Promise<void>;

  cleanupCompletedBuild?(input: CleanupCompletedProviderSessionBuildInput): Promise<void>;

  deleteImage(input: DeleteRepoImageInput): Promise<void>;
}

export type RepoImageBuildAdapter<Plan extends RepoImageBuildPlan> = RepoImageBuildFinalizer & {
  startBuild(plan: Plan, callbacks: RepoImageBuildStartCallbacks): Promise<void>;
};

export type AnyRepoImageBuildAdapter =
  | RepoImageBuildAdapter<ModalRepoImageBuildPlan>
  | RepoImageBuildAdapter<VercelRepoImageBuildPlan>
  | RepoImageBuildAdapter<OpenComputerRepoImageBuildPlan>;
