import type { CorrelationContext } from "../logger";
import type {
  EnvironmentImageRepositorySha,
  EnvironmentImageProviderImageRef,
  SupersededEnvironmentImage,
} from "./model";

export type EnvironmentImageWorkflowContext = CorrelationContext;

/** One environment repository as handed to a build, in position order ([0] = primary). */
export interface EnvironmentImageBuildRepository {
  repoOwner: string;
  repoName: string;
  baseBranch: string;
}

/**
 * Triggering is idempotent under the per-environment concurrency rule
 * (design §7.3): a second trigger while a build is in flight reports the
 * existing build instead of stacking another. `up_to_date` is returned only
 * by the save-hook variant, when a ready image already matches the current
 * repository set.
 */
export type TriggerEnvironmentImageBuildResult =
  | { type: "triggered"; buildId: string }
  | { type: "already_building"; buildId: string }
  | { type: "up_to_date" };

export type EnvironmentImageWorkflowResult =
  | { type: "completion_accepted"; finalization: Promise<void> }
  | {
      type: "build_ready";
      replacedImages: SupersededEnvironmentImage[];
      cleanup?: Promise<void>;
    }
  | { type: "build_superseded"; cleanup?: Promise<void> }
  | { type: "build_failed"; cleanup?: Promise<void> };

/** Provider-neutral build request fields resolved before adapter-specific execution. */
interface BaseEnvironmentImageBuildPlan {
  buildId: string;
  environmentId: string;
  repositories: EnvironmentImageBuildRepository[];
  repositoriesFingerprint: string;
  callbackUrl: string;
  buildTimeoutMs: number;
  userEnvVars?: Record<string, string>;
  correlation: CorrelationContext;
}

/** Modal's data-plane builder returns the provider image id directly in its callback. */
export interface ModalEnvironmentImageBuildPlan extends BaseEnvironmentImageBuildPlan {
  provider: "modal";
  callbackMode: "provider_image";
}

/** Same clone-auth shape as repo-image builds (repo-images/types.ts). */
export type EnvironmentImageCloneAuth =
  | { type: "credential_helper"; token: string }
  | { type: "unavailable" };

/** Vercel builds inside a sandbox; the control plane snapshots it after callback success. */
export interface VercelEnvironmentImageBuildPlan extends BaseEnvironmentImageBuildPlan {
  provider: "vercel";
  callbackMode: "provider_session";
  callbackToken: string;
  cloneAuth: EnvironmentImageCloneAuth;
}

/** OpenComputer builds inside a sandbox; the control plane checkpoints it after callback success. */
export interface OpenComputerEnvironmentImageBuildPlan extends BaseEnvironmentImageBuildPlan {
  provider: "opencomputer";
  callbackMode: "provider_session";
  callbackToken: string;
  cloneAuth: EnvironmentImageCloneAuth;
}

export type EnvironmentImageBuildPlan =
  | ModalEnvironmentImageBuildPlan
  | VercelEnvironmentImageBuildPlan
  | OpenComputerEnvironmentImageBuildPlan;

export type PlannedEnvironmentImageBuild =
  | { plan: ModalEnvironmentImageBuildPlan; callbackAuth: { type: "none" } }
  | {
      plan: VercelEnvironmentImageBuildPlan;
      callbackAuth: { type: "bearer_token"; tokenHash: string; expiresAt: number };
    }
  | {
      plan: OpenComputerEnvironmentImageBuildPlan;
      callbackAuth: { type: "bearer_token"; tokenHash: string; expiresAt: number };
    };

/** Lets provider-session adapters bind the provider sandbox id before the runtime launches. */
export interface EnvironmentImageBuildStartCallbacks {
  bindProviderSession(providerSessionId: string): Promise<void>;
}

/**
 * Wire form of the build-complete callback after route-level parsing.
 * repository_shas and runtime_version are reported by the build itself
 * (design §7.3) — registration fails closed when either is missing or
 * unparseable, because an unversioned image must never pass the floor check.
 */
export interface CompleteEnvironmentImageBuildCallback {
  buildId: string;
  providerImageId?: string;
  providerSessionId?: string;
  repositoryShas?: EnvironmentImageRepositorySha[];
  runtimeVersion?: string;
  buildDurationMs?: number;
}

export interface FailEnvironmentImageBuildCallback {
  buildId: string;
  providerSessionId?: string;
  errorMessage: string;
}

export interface DeleteEnvironmentImageInput {
  image: EnvironmentImageProviderImageRef;
  correlation?: CorrelationContext;
}

/** Finalization input for provider-session builds (the deferred snapshot/checkpoint). */
export interface FinalizeEnvironmentImageBuildInput {
  buildId: string;
  providerSessionId: string;
  correlation: CorrelationContext;
}

export interface FailedEnvironmentImageBuildInput {
  buildId: string;
  providerSessionId: string;
  errorMessage: string;
  correlation: CorrelationContext;
}

/**
 * Provider-facing operations for environment image builds. The workflow owns
 * state transitions; adapters own translating lifecycle steps into provider
 * API calls (start build, snapshot/checkpoint, teardown, artifact deletion).
 * The finalize/cleanup hooks apply to provider_session builds only — Modal's
 * callback already carries the artifact id.
 */
export type EnvironmentImageBuildAdapter<Plan extends EnvironmentImageBuildPlan> = {
  startBuild(plan: Plan, callbacks: EnvironmentImageBuildStartCallbacks): Promise<void>;
  deleteImage(input: DeleteEnvironmentImageInput): Promise<void>;
  finalizeSuccessfulBuild?(
    input: FinalizeEnvironmentImageBuildInput
  ): Promise<EnvironmentImageProviderImageRef>;
  cleanupFailedBuild?(input: FailedEnvironmentImageBuildInput): Promise<void>;
  cleanupCompletedBuild?(input: FinalizeEnvironmentImageBuildInput): Promise<void>;
};

export type AnyEnvironmentImageBuildAdapter =
  | EnvironmentImageBuildAdapter<ModalEnvironmentImageBuildPlan>
  | EnvironmentImageBuildAdapter<VercelEnvironmentImageBuildPlan>
  | EnvironmentImageBuildAdapter<OpenComputerEnvironmentImageBuildPlan>;
