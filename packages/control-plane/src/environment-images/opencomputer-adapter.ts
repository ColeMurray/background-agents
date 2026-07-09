import { createLogger } from "../logger";
import type { OpenComputerSandboxProvider } from "../sandbox/providers/opencomputer-provider";
import type { EnvironmentImageProviderImageRef } from "./model";
import type {
  DeleteEnvironmentImageInput,
  EnvironmentImageBuildAdapter,
  EnvironmentImageBuildStartCallbacks,
  FailedEnvironmentImageBuildInput,
  FinalizeEnvironmentImageBuildInput,
  OpenComputerEnvironmentImageBuildPlan,
} from "./types";

const logger = createLogger("environment-images:opencomputer-adapter");
const MS_PER_SECOND = 1000;

/**
 * OpenComputer adapter for provider-session environment image builds.
 *
 * Builds run in a temporary OpenComputer sandbox. On success, the adapter
 * checkpoints that sandbox into the environment image artifact; cleanup hooks
 * handle teardown.
 */
export class OpenComputerEnvironmentImageBuildAdapter implements EnvironmentImageBuildAdapter<OpenComputerEnvironmentImageBuildPlan> {
  constructor(private readonly provider: OpenComputerSandboxProvider) {}

  async startBuild(
    plan: OpenComputerEnvironmentImageBuildPlan,
    callbacks: EnvironmentImageBuildStartCallbacks
  ): Promise<void> {
    await this.provider.triggerEnvironmentImageBuild({
      environmentId: plan.environmentId,
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
    input: FinalizeEnvironmentImageBuildInput
  ): Promise<EnvironmentImageProviderImageRef> {
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

  async cleanupCompletedBuild(input: FinalizeEnvironmentImageBuildInput): Promise<void> {
    await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
  }

  async cleanupFailedBuild(input: FailedEnvironmentImageBuildInput): Promise<void> {
    await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
  }

  async deleteImage(input: DeleteEnvironmentImageInput): Promise<void> {
    await this.provider.deleteProviderImage(
      input.image.providerImageId,
      input.image.providerSessionId
    );
  }

  private async deleteBuildSandbox(
    buildId: string,
    providerSessionId: string,
    correlation: FinalizeEnvironmentImageBuildInput["correlation"]
  ): Promise<void> {
    try {
      await this.provider.deleteSandbox(providerSessionId, { deleteSecretStore: true });
    } catch (error) {
      logger.warn("environment_image.opencomputer_build_cleanup_failed", {
        build_id: buildId,
        provider_session_id: providerSessionId,
        error: error instanceof Error ? error.message : String(error),
        request_id: correlation.request_id,
        trace_id: correlation.trace_id,
      });
    }
  }
}
