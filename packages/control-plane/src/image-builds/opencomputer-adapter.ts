import { createLogger } from "../logger";
import type { OpenComputerSandboxProvider } from "../sandbox/providers/opencomputer-provider";
import type { ImageBuildProviderImageRef } from "./model";
import type {
  DeleteImageInput,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildStartCallbacks,
  OpenComputerImageBuildPlan,
} from "./types";

const logger = createLogger("image-builds:opencomputer-adapter");
const MS_PER_SECOND = 1000;

/**
 * OpenComputer adapter for provider-session image builds.
 *
 * Builds run in a temporary OpenComputer sandbox. On success, the adapter
 * checkpoints that sandbox into the image artifact; cleanup hooks handle
 * teardown.
 */
export class OpenComputerImageBuildAdapter implements ImageBuildAdapter<OpenComputerImageBuildPlan> {
  constructor(private readonly provider: OpenComputerSandboxProvider) {}

  async startBuild(
    plan: OpenComputerImageBuildPlan,
    callbacks: ImageBuildStartCallbacks
  ): Promise<void> {
    await this.provider.triggerEnvironmentImageBuild({
      // The provider API is keyed by environment id; scope.id is that id for
      // every scope kind that exists until the unified data plane lands.
      environmentId: plan.scope.id,
      repositories: plan.repositories,
      buildId: plan.buildId,
      callbackUrl: plan.callbackUrl,
      callbackToken: plan.callbackToken,
      userEnvVars: plan.userEnvVars,
      cloneToken: plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.token : undefined,
      buildTimeoutSeconds: Math.ceil(plan.buildTimeoutMs / MS_PER_SECOND),
      onProviderSessionCreated: callbacks.bindProviderSession,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeImageBuildInput
  ): Promise<ImageBuildProviderImageRef> {
    const snapshot = await this.provider.takeSnapshot({
      providerObjectId: input.providerSessionId,
      sessionId: input.buildId,
      reason: "environment_image_build",
      correlation: {
        ...input.correlation,
        sandbox_id: input.providerSessionId,
      },
    });

    if (!snapshot.success || !snapshot.imageId) {
      throw new Error(snapshot.error || "OpenComputer checkpoint did not return an image id");
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
    await this.provider.deleteProviderImage(
      input.image.providerImageId,
      input.image.providerSessionId
    );
  }

  private async deleteBuildSandbox(
    buildId: string,
    providerSessionId: string,
    correlation: FinalizeImageBuildInput["correlation"]
  ): Promise<void> {
    try {
      await this.provider.deleteSandbox(providerSessionId, { deleteSecretStore: true });
    } catch (error) {
      logger.warn("image_build.opencomputer_build_cleanup_failed", {
        build_id: buildId,
        provider_session_id: providerSessionId,
        error: error instanceof Error ? error.message : String(error),
        request_id: correlation.request_id,
        trace_id: correlation.trace_id,
      });
    }
  }
}
