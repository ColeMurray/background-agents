import type { ModalImageBuildProvider } from "../sandbox/providers/modal-provider";
import type {
  DeleteImageInput,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildStartCallbacks,
  ModalImageBuildPlan,
} from "./types";

/**
 * Modal adapter for provider-session image builds.
 */
export class ModalImageBuildAdapter implements ImageBuildAdapter<ModalImageBuildPlan> {
  constructor(private readonly provider: ModalImageBuildProvider) {}

  async startBuild(plan: ModalImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
    await this.provider.triggerEnvironmentImageBuild({
      scopeKind: plan.scope.kind,
      scopeId: plan.scope.id,
      buildId: plan.buildId,
      repositories: plan.repositories,
      cloneToken: plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.token : undefined,
      cloneHost: plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.host : undefined,
      cloneUsername:
        plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.username : undefined,
      userEnvVars: plan.userEnvVars,
      buildTimeoutMs: plan.buildTimeoutMs,
      callbackUrl: plan.callbackUrl,
      failureCallbackUrl: plan.failureCallbackUrl,
      callbackToken: plan.callbackToken,
      onProviderSessionCreated: callbacks.bindProviderSession,
      correlation: plan.correlation,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeImageBuildInput
  ): Promise<{ providerImageId: string; providerSessionId: string }> {
    const result = await this.provider.snapshotImageBuildSandbox({
      buildId: input.buildId,
      providerSessionId: input.providerSessionId,
      correlation: { ...input.correlation, sandbox_id: input.providerSessionId },
    });
    if (!result.success || !result.imageId) {
      throw new Error(result.error || "Modal image build snapshot failed");
    }
    return {
      providerImageId: result.imageId,
      providerSessionId: input.providerSessionId,
    };
  }

  async cleanupCompletedBuild(input: FinalizeImageBuildInput): Promise<void> {
    await this.terminateBuildSandbox(input, "image_build_complete");
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.terminateBuildSandbox(input, "image_build_failed");
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.image.providerImageId, input.correlation);
  }

  private async terminateBuildSandbox(
    input: FinalizeImageBuildInput | FailedImageBuildInput,
    reason: string
  ): Promise<void> {
    await this.provider.terminateImageBuildSandbox({
      buildId: input.buildId,
      providerSessionId: input.providerSessionId,
      reason,
      correlation: input.correlation,
    });
  }
}
