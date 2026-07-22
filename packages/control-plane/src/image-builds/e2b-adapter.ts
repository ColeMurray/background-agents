import type { E2BSandboxProvider } from "../sandbox/providers/e2b-provider";
import type { ImageBuildProviderImageRef } from "./model";
import type {
  DeleteImageInput,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildPlan,
  ImageBuildStartCallbacks,
} from "./types";
import { resolveImageBuildProviderSessionTimeoutSeconds } from "./timeouts";

const MS_PER_SECOND = 1000;

/**
 * E2B adapter for provider-session image builds.
 *
 * Builds run in a temporary E2B sandbox. On success, the adapter bakes that
 * sandbox's filesystem into a reusable snapshot template; teardown kills the
 * build sandbox (E2B stop only pauses, which would leak the single-use box).
 *
 * Quiescing the build process before the snapshot is owned by the provider's
 * takeSnapshot (pause keepMemory:false → connect cold-boot → snapshot), so the
 * adapter neither waits nor guesses when the build supervisor has exited.
 */
export class E2BImageBuildAdapter implements ImageBuildAdapter {
  constructor(private readonly provider: E2BSandboxProvider) {}

  async startBuild(plan: ImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
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
      buildExecutionTimeoutSeconds: Math.ceil(plan.buildTimeoutMs / MS_PER_SECOND),
      providerSessionTimeoutSeconds: resolveImageBuildProviderSessionTimeoutSeconds(
        plan.buildTimeoutMs
      ),
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
    });

    if (!snapshot.success || !snapshot.imageId) {
      throw new Error(snapshot.error || "E2B snapshot did not return an image id");
    }

    return {
      providerImageId: snapshot.imageId,
      providerSessionId: input.providerSessionId,
    };
  }

  async cleanupCompletedBuild(input: FinalizeImageBuildInput): Promise<void> {
    // The snapshot taken in finalizeSuccessfulBuild is a standalone template;
    // it does not reference the build sandbox, so the box can be killed once
    // the build is done. E2B stop only pauses, so delete rather than stop.
    await this.provider.deleteSandbox(input.providerSessionId);
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.provider.deleteSandbox(input.providerSessionId);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.image.providerImageId);
  }
}
