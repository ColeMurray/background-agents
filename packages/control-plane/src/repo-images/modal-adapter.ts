import type { ModalRepoImageBuildProvider } from "../sandbox/providers/modal-provider";
import type {
  DeleteRepoImageInput,
  FinalizeRepoImageBuildInput,
  FinalizeRepoImageBuildResult,
  ModalRepoImageBuildPlan,
  RepoImageBuildAdapter,
  RepoImageBuildStartCallbacks,
} from "./types";

export class ModalRepoImageBuildAdapter implements RepoImageBuildAdapter<ModalRepoImageBuildPlan> {
  constructor(private readonly provider: ModalRepoImageBuildProvider) {}

  async startBuild(
    modalPlan: ModalRepoImageBuildPlan,
    _callbacks: RepoImageBuildStartCallbacks
  ): Promise<void> {
    await this.provider.triggerRepoImageBuild({
      repoOwner: modalPlan.repoOwner,
      repoName: modalPlan.repoName,
      defaultBranch: modalPlan.baseBranch,
      buildId: modalPlan.buildId,
      callbackUrl: modalPlan.callbackUrl,
      userEnvVars: modalPlan.userEnvVars,
      buildTimeoutMs: modalPlan.buildTimeoutMs,
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
    await this.provider.deleteProviderImage(input.image.providerImageId, input.correlation);
  }
}
