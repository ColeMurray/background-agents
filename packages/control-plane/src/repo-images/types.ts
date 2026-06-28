import type { CorrelationContext } from "../logger";

export type RepoImageCallbackMode = "provider_image" | "provider_session";
export type RepoImageWorkflowContext = CorrelationContext;

export interface ReplacedRepoImage {
  providerImageId: string;
  providerSessionId: string | null;
}

export type RepoImageWorkflowResult =
  | { type: "build_triggered"; buildId: string }
  | { type: "completion_accepted"; finalization: Promise<void> }
  | { type: "build_ready"; replacedImages: ReplacedRepoImage[]; cleanup?: Promise<void> }
  | { type: "build_failed"; cleanup?: Promise<void> }
  | { type: "callback_auth_rejected"; message: string }
  | { type: "callback_auth_unavailable"; message: string }
  | { type: "repository_not_installed"; message: string }
  | { type: "repo_image_workflow_unavailable"; message: string }
  | { type: "repo_image_provider_unconfigured"; message: string }
  | { type: "completion_not_accepted"; message: string }
  | { type: "failure_not_accepted"; message: string }
  | {
      type: "workflow_failed";
      operation: "trigger_build" | "build_complete" | "build_failed";
      message: string;
    };

interface BaseRepoImageBuildPlan {
  buildId: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  callbackUrl: string;
  buildTimeoutSeconds: number;
  userEnvVars?: Record<string, string>;
  correlation: CorrelationContext;
}

export interface ModalRepoImageBuildPlan extends BaseRepoImageBuildPlan {
  provider: "modal";
  callbackMode: "provider_image";
}

export type VercelCloneAuth =
  | { type: "credential_helper"; token: string }
  | { type: "unavailable" };

export interface VercelRepoImageBuildPlan extends BaseRepoImageBuildPlan {
  provider: "vercel";
  callbackMode: "provider_session";
  callbackToken: string;
  cloneAuth: VercelCloneAuth;
}

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

export interface RepoImageBuildStartCallbacks {
  bindProviderSession(providerSessionId: string): Promise<void>;
}

export interface CompleteProviderImageBuild {
  kind: "provider_image";
  buildId: string;
  providerImageId: string;
  baseSha: string;
  buildDurationSeconds: number;
}

export interface CompleteProviderSessionBuild {
  kind: "provider_session";
  buildId: string;
  providerSessionId: string;
  baseSha: string;
  buildDurationSeconds: number;
}

export type CompleteRepoImageBuild = CompleteProviderImageBuild | CompleteProviderSessionBuild;

export type FinalizeRepoImageBuildInput = CompleteRepoImageBuild & {
  correlation: CorrelationContext;
};

export interface FinalizeRepoImageBuildResult {
  providerImageId: string;
  providerSessionId?: string;
}

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

export type FailedRepoImageBuildInput = FailRepoImageBuild & {
  correlation: CorrelationContext;
};

export interface DeleteRepoImageInput {
  providerImageId: string;
  providerSessionId?: string | null;
  correlation?: CorrelationContext;
}

export interface RepoImageBuildAdapter {
  startBuild(plan: RepoImageBuildPlan, callbacks: RepoImageBuildStartCallbacks): Promise<void>;

  finalizeSuccessfulBuild(
    input: FinalizeRepoImageBuildInput
  ): Promise<FinalizeRepoImageBuildResult>;

  cleanupFailedBuild?(input: FailedRepoImageBuildInput): Promise<void>;

  deleteImage(input: DeleteRepoImageInput): Promise<void>;
}
