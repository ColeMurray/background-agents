import { ModalApiError } from "../sandbox/client";
import { SandboxProviderError } from "../sandbox/provider";
import type { ModalImageBuildProvider } from "../sandbox/providers/modal-provider";
import type {
  DeleteImageInput,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildPlan,
  ImageBuildStartCallbacks,
} from "./types";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import { resolveImageBuildProviderSessionTimeoutMs } from "./timeouts";

/**
 * Modal provider-session image build adapter.
 */
export class ModalImageBuildAdapter implements ImageBuildAdapter {
  constructor(private readonly provider: ModalImageBuildProvider) {}

  async startBuild(plan: ImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
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
      buildExecutionTimeoutSeconds: Math.ceil(plan.buildTimeoutMs / 1000),
      providerSessionTimeoutMs: resolveImageBuildProviderSessionTimeoutMs(plan.buildTimeoutMs),
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
    let result;
    try {
      result = await this.provider.snapshotImageBuildSandbox({
        buildId: input.buildId,
        providerSessionId: input.providerSessionId,
        correlation: { ...input.correlation, sandbox_id: input.providerSessionId },
        signal: input.signal,
      });
    } catch (error) {
      if (
        error instanceof SandboxProviderError &&
        error.cause instanceof ModalApiError &&
        error.cause.status === 429
      ) {
        throw new ImageBuildFinalizationAttemptError(error.message, "definitely_not_created", {
          cause: error,
        });
      }
      throw error;
    }
    if (!result.success || !result.imageId) {
      throw new Error(result.error || "Modal image build snapshot failed");
    }
    return {
      providerImageId: result.imageId,
      providerSessionId: input.providerSessionId,
    };
  }

  async cleanupCompletedBuild(input: FinalizeImageBuildInput): Promise<void> {
    await this.provider.terminateImageBuildSandbox({
      buildId: input.buildId,
      providerSessionId: input.providerSessionId,
      reason: "image_build_complete",
      correlation: input.correlation,
      signal: input.signal,
    });
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.provider.terminateImageBuildSandbox({
      buildId: input.buildId,
      providerSessionId: input.providerSessionId,
      reason: "image_build_failed",
      correlation: input.correlation,
      signal: input.signal,
    });
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(
      input.image.providerImageId,
      input.correlation,
      ...(input.signal ? [input.signal] : [])
    );
  }
}
