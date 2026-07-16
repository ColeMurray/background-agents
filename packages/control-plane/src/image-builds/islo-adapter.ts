import { createLogger } from "../logger";
import type { IsloSandboxProvider } from "../sandbox/providers/islo-provider";
import type { ImageBuildProviderImageRef } from "./model";
import type {
  DeleteImageInput,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildStartCallbacks,
  IsloImageBuildPlan,
} from "./types";

const logger = createLogger("image-builds:islo-adapter");
const MS_PER_SECOND = 1000;

/**
 * Islo adapter for provider-session repo image builds.
 *
 * Builds run in a temporary Islo sandbox. On success, the adapter snapshots the
 * sandbox into the durable repo image artifact and then deletes the build VM.
 */
export class IsloImageBuildAdapter implements ImageBuildAdapter<IsloImageBuildPlan> {
  constructor(private readonly provider: IsloSandboxProvider) {}

  async startBuild(plan: IsloImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
    const primaryRepo = plan.repositories[0];
    await this.provider.triggerRepoImageBuild({
      repoOwner: primaryRepo.repoOwner,
      repoName: primaryRepo.repoName,
      defaultBranch: primaryRepo.baseBranch,
      buildId: plan.buildId,
      callbackUrl: plan.callbackUrl,
      callbackToken: plan.callbackToken,
      userEnvVars: plan.userEnvVars,
      cloneToken: plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.token : undefined,
      buildTimeoutSeconds: Math.ceil(plan.buildTimeoutMs / MS_PER_SECOND),
      onProviderSessionCreated: callbacks.bindProviderSession,
      correlation: plan.correlation,
    });
  }

  async finalizeSuccessfulBuild(input: FinalizeImageBuildInput): Promise<ImageBuildProviderImageRef> {
    const snapshot = await this.provider.takeSnapshot({
      providerObjectId: input.providerSessionId,
      sessionId: input.buildId,
      reason: "image_build",
      correlation: {
        ...input.correlation,
        sandbox_id: input.providerSessionId,
      },
    });

    if (!snapshot.success || !snapshot.imageId) {
      throw new Error(snapshot.error || "Islo snapshot did not return an image id");
    }

    return {
      providerImageId: snapshot.imageId,
      providerSessionId: input.providerSessionId,
    };
  }

  async cleanupCompletedBuild(input: FinalizeImageBuildInput): Promise<void> {
    await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.image.providerImageId);
  }

  private async deleteBuildSandbox(
    buildId: string,
    providerSessionId: string,
    correlation: FinalizeImageBuildInput["correlation"]
  ): Promise<void> {
    try {
      await this.provider.deleteSandbox(providerSessionId);
    } catch (error) {
      logger.warn("image_build.islo_build_cleanup_failed", {
        build_id: buildId,
        provider_session_id: providerSessionId,
        error: error instanceof Error ? error.message : String(error),
        request_id: correlation.request_id,
        trace_id: correlation.trace_id,
      });
    }
  }
}
