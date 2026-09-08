import {
  VERCEL_MAX_SANDBOX_TIMEOUT_MS,
  type VercelSandboxProvider,
} from "../sandbox/providers/vercel/provider";
import type { ImageBuildProviderImageRef } from "./model";
import type {
  DeleteImageInput,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildPlan,
  ImageBuildStartCallbacks,
} from "./types";
import {
  IMAGE_BUILD_FINALIZATION_GRACE_MS,
  resolveImageBuildProviderSessionTimeoutSeconds,
} from "./timeouts";

/**
 * Vercel adapter for provider-session image builds.
 *
 * Builds run in a temporary Vercel sandbox. On success, the adapter turns
 * that sandbox into the durable image artifact; cleanup hooks handle
 * teardown.
 */
export class VercelImageBuildAdapter implements ImageBuildAdapter {
  constructor(private readonly provider: VercelSandboxProvider) {}

  async startBuild(plan: ImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
    const executionTimeoutMs = Math.min(
      plan.buildTimeoutMs,
      VERCEL_MAX_SANDBOX_TIMEOUT_MS - IMAGE_BUILD_FINALIZATION_GRACE_MS
    );
    await this.provider.triggerImageBuild({
      scopeKind: plan.scope.kind,
      scopeId: plan.scope.id,
      repositories: plan.repositories,
      buildId: plan.buildId,
      callbackUrl: plan.callbackUrl,
      failureCallbackUrl: plan.failureCallbackUrl,
      callbackToken: plan.callbackToken,
      userEnvVars: plan.userEnvVars,
      cloneToken: plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.token : undefined,
      buildExecutionTimeoutSeconds: Math.ceil(executionTimeoutMs / 1000),
      providerSessionTimeoutSeconds:
        resolveImageBuildProviderSessionTimeoutSeconds(executionTimeoutMs),
      onProviderSessionCreated: callbacks.bindProviderSession,
      correlation: plan.correlation,
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
      signal: input.signal,
    });

    if (!snapshot.success || !snapshot.imageId) {
      throw new Error(snapshot.error || "Vercel snapshot did not return an image id");
    }

    return {
      providerImageId: snapshot.imageId,
      providerSessionId: input.providerSessionId,
    };
  }

  async cleanupCompletedBuild(input: FinalizeImageBuildInput): Promise<void> {
    await this.stopBuildSandbox(input);
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.stopBuildSandbox(input);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(
      input.image.providerImageId,
      ...(input.signal ? [input.signal] : [])
    );
  }

  private async stopBuildSandbox(input: {
    buildId: string;
    providerSessionId: string;
    correlation: FinalizeImageBuildInput["correlation"];
    signal?: AbortSignal;
  }): Promise<void> {
    const stopResult = await this.provider.stopSandbox({
      providerObjectId: input.providerSessionId,
      sessionId: input.buildId,
      reason: "environment_image_build_complete",
      correlation: {
        ...input.correlation,
        sandbox_id: input.providerSessionId,
      },
      signal: input.signal,
    });
    if (!stopResult.success) {
      throw new Error(stopResult.error || "Failed to stop Vercel build sandbox");
    }
  }
}
