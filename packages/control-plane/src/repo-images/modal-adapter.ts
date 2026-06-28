import type { ModalRepoImageBuildProvider } from "../sandbox/providers/modal-provider";
import type {
  DeleteRepoImageInput,
  FinalizeRepoImageBuildInput,
  FinalizeRepoImageBuildResult,
  ModalRepoImageBuildPlan,
  RepoImageBuildAdapter,
  RepoImageBuildPlan,
  RepoImageBuildStartCallbacks,
} from "./types";

export class ModalRepoImageBuildAdapter implements RepoImageBuildAdapter {
  constructor(private readonly provider: ModalRepoImageBuildProvider) {}

  async startBuild(
    plan: RepoImageBuildPlan,
    _callbacks: RepoImageBuildStartCallbacks
  ): Promise<void> {
    const modalPlan = requireModalPlan(plan);
    await this.provider.triggerRepoImageBuild({
      repoOwner: modalPlan.repoOwner,
      repoName: modalPlan.repoName,
      defaultBranch: modalPlan.baseBranch,
      buildId: modalPlan.buildId,
      callbackUrl: modalPlan.callbackUrl,
      userEnvVars: modalPlan.userEnvVars,
      buildTimeoutSeconds: modalPlan.buildTimeoutSeconds,
      correlation: modalPlan.correlation,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeRepoImageBuildInput
  ): Promise<FinalizeRepoImageBuildResult> {
    if (input.kind !== "provider_image") {
      throw new Error("provider_image_id is required for Modal repo image completion");
    }
    return { providerImageId: input.providerImageId };
  }

  async deleteImage(input: DeleteRepoImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.providerImageId, input.correlation);
  }
}

function requireModalPlan(plan: RepoImageBuildPlan): ModalRepoImageBuildPlan {
  if (plan.provider !== "modal") {
    throw new Error(`Modal adapter received ${plan.provider} repo image build plan`);
  }
  return plan;
}
