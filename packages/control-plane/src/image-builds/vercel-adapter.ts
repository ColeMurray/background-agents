import { createLogger } from "../logger";
import type { VercelSandboxProvider } from "../sandbox/providers/vercel/provider";
import type { ImageBuildProviderImageRef } from "./model";
import type {
  DeleteImageInput,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildStartCallbacks,
  VercelImageBuildPlan,
} from "./types";

const logger = createLogger("image-builds:vercel-adapter");
const MS_PER_SECOND = 1000;

/**
 * Vercel adapter for provider-session image builds.
 *
 * Builds run in a temporary Vercel sandbox. On success, the adapter turns
 * that sandbox into the durable image artifact; cleanup hooks handle
 * teardown.
 */
export class VercelImageBuildAdapter implements ImageBuildAdapter<VercelImageBuildPlan> {
  constructor(private readonly provider: VercelSandboxProvider) {}

  async startBuild(plan: VercelImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
    await this.provider.triggerEnvironmentImageBuild({
      // The provider build API is keyed by environmentId (used only for
      // sandbox naming/labels); scope.id fills it for every scope kind.
      environmentId: plan.scope.id,
      repositories: plan.repositories,
      buildId: plan.buildId,
      callbackUrl: plan.callbackUrl,
      failureCallbackUrl: plan.failureCallbackUrl,
      callbackToken: plan.callbackToken,
      userEnvVars: plan.userEnvVars,
      cloneToken: plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.token : undefined,
      buildTimeoutSeconds: Math.ceil(plan.buildTimeoutMs / MS_PER_SECOND),
      onProviderSessionCreated: callbacks.bindProviderSession,
      correlation: plan.correlation,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeImageBuildInput
  ): Promise<ImageBuildProviderImageRef> {
    try {
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
        throw new Error(snapshot.error || "Vercel snapshot did not return an image id");
      }

      return {
        providerImageId: snapshot.imageId,
        providerSessionId: input.providerSessionId,
      };
    } finally {
      await this.stopBuildSandbox(input);
    }
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.stopBuildSandbox(input);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.image.providerImageId);
  }

  private async stopBuildSandbox(input: {
    buildId: string;
    providerSessionId: string;
    correlation: FinalizeImageBuildInput["correlation"];
  }): Promise<void> {
    try {
      const stopResult = await this.provider.stopSandbox({
        providerObjectId: input.providerSessionId,
        sessionId: input.buildId,
        reason: "environment_image_build_complete",
        correlation: {
          ...input.correlation,
          sandbox_id: input.providerSessionId,
        },
      });
      if (!stopResult.success) {
        throw new Error(stopResult.error || "Failed to stop Vercel build sandbox");
      }
    } catch (error) {
      logger.warn("image_build.vercel_build_stop_failed", {
        build_id: input.buildId,
        provider_session_id: input.providerSessionId,
        error: error instanceof Error ? error.message : String(error),
        request_id: input.correlation.request_id,
        trace_id: input.correlation.trace_id,
      });
    }
  }
}
