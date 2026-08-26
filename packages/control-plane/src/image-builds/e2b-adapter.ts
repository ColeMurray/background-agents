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
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import { E2BApiError } from "../sandbox/e2b-rest-client";
import { SandboxProviderError } from "../sandbox/provider";

const MS_PER_SECOND = 1000;

/**
 * E2B adapter for provider-session image builds.
 *
 * Builds run in a temporary E2B sandbox. On success, the adapter bakes that
 * sandbox's filesystem into a reusable snapshot template; teardown kills the
 * build sandbox (E2B stop only pauses, which would leak the single-use box).
 *
 * Quiescing the build process before the snapshot is owned by the provider's
 * takePrebuiltImageSnapshot (pause memory:false → connect cold-boot → snapshot),
 * so the adapter neither waits nor guesses when the build supervisor has exited.
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
    let snapshot;
    try {
      snapshot = await this.provider.takePrebuiltImageSnapshot({
        providerObjectId: input.providerSessionId,
        sessionId: input.buildId,
        reason: "environment_image_build",
        correlation: {
          ...input.correlation,
          sandbox_id: input.providerSessionId,
        },
        signal: input.signal,
      });
    } catch (error) {
      // ImageBuildFinalizer retries only definitely_not_created; anything else
      // fails the build and kills the sandbox. A 429 is a *rejected* request, so
      // none of pause / connect / createSnapshot can have produced a template —
      // translate it into a retry, as ModalImageBuildAdapter does.
      if (
        error instanceof SandboxProviderError &&
        error.cause instanceof E2BApiError &&
        error.cause.status === 429
      ) {
        throw new ImageBuildFinalizationAttemptError(error.message, "definitely_not_created", {
          cause: error,
        });
      }
      throw error;
    }

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
    await this.deleteBuildSandbox(input.providerSessionId, input.signal);
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.deleteBuildSandbox(input.providerSessionId, input.signal);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(
      input.image.providerImageId,
      ...(input.signal ? [input.signal] : [])
    );
  }

  private async deleteBuildSandbox(providerSessionId: string, signal?: AbortSignal): Promise<void> {
    await this.provider.deleteSandbox(providerSessionId, ...(signal ? [signal] : []));
  }
}
