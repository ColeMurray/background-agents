import type { CorrelationContext } from "../logger";
import type {
  EnvironmentImageMemberSha,
  EnvironmentImageProviderImageRef,
  SupersededEnvironmentImage,
} from "./model";

export type EnvironmentImageWorkflowContext = CorrelationContext;

/** One environment member as handed to a build, in position order ([0] = primary). */
export interface EnvironmentImageBuildMember {
  repoOwner: string;
  repoName: string;
  baseBranch: string;
}

/**
 * Triggering is idempotent under the per-environment concurrency rule
 * (design §7.3): a second trigger while a build is in flight reports the
 * existing build instead of stacking another. `up_to_date` is returned only
 * by the save-hook variant, when a ready image already matches the current
 * member set.
 */
export type TriggerEnvironmentImageBuildResult =
  | { type: "triggered"; buildId: string }
  | { type: "already_building"; buildId: string }
  | { type: "up_to_date" };

export type EnvironmentImageWorkflowResult =
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
  repositories: EnvironmentImageBuildMember[];
  membersFingerprint: string;
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

export type EnvironmentImageBuildPlan = ModalEnvironmentImageBuildPlan;

export type PlannedEnvironmentImageBuild = {
  plan: ModalEnvironmentImageBuildPlan;
  callbackAuth: { type: "none" };
};

/** Lets provider-session adapters bind the provider sandbox id before the runtime launches. */
export interface EnvironmentImageBuildStartCallbacks {
  bindProviderSession(providerSessionId: string): Promise<void>;
}

/**
 * Wire form of the build-complete callback after route-level parsing.
 * member_shas and runtime_version are reported by the build itself
 * (design §7.3) — registration fails closed when either is missing or
 * unparseable, because an unversioned image must never pass the floor check.
 */
export interface CompleteEnvironmentImageBuildCallback {
  buildId: string;
  providerImageId?: string;
  providerSessionId?: string;
  memberShas?: EnvironmentImageMemberSha[];
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

/**
 * Provider-facing operations for environment image builds. The workflow owns
 * state transitions; adapters own translating lifecycle steps into provider
 * API calls (start build, delete artifact).
 */
export type EnvironmentImageBuildAdapter<Plan extends EnvironmentImageBuildPlan> = {
  startBuild(plan: Plan, callbacks: EnvironmentImageBuildStartCallbacks): Promise<void>;
  deleteImage(input: DeleteEnvironmentImageInput): Promise<void>;
};

export type AnyEnvironmentImageBuildAdapter =
  EnvironmentImageBuildAdapter<ModalEnvironmentImageBuildPlan>;
