import type { OpenComputerSandboxProvider } from "../sandbox/providers/opencomputer-provider";
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

/**
 * OpenComputer adapter for provider-session image builds.
 *
 * Builds run in a temporary OpenComputer sandbox. On success, the adapter
 * checkpoints that sandbox into the image artifact; cleanup hooks handle
 * teardown.
 */
export class OpenComputerImageBuildAdapter implements ImageBuildAdapter {
  constructor(private readonly provider: OpenComputerSandboxProvider) {}

  async startBuild(plan: ImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
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
      buildExecutionTimeoutSeconds: Math.ceil(plan.buildTimeoutMs / 1000),
      providerSessionTimeoutSeconds: resolveImageBuildProviderSessionTimeoutSeconds(
        plan.buildTimeoutMs
      ),
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
      signal: input.signal,
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
    // Keep the secret store. A successful build was checkpointed in
    // finalizeSuccessfulBuild, and an OpenComputer checkpoint retains its build
    // sandbox's secret store as a base layer that every from-checkpoint fork
    // re-merges. Deleting it here is what made spawns from the image fail with
    // "secret store not found". The store is cheap encrypted-KV metadata; one
    // that outlives its image is reclaimed by the orphaned-store sweep, not at
    // build teardown (the sandbox is gone by the time the image is deleted, so
    // there is no attachment left to delete it through).
    await this.deleteBuildSandbox(
      input.providerSessionId,
      {
        deleteSecretStore: false,
      },
      input.signal
    );
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    // A failed build produced no checkpoint, so nothing references its store —
    // delete it with the sandbox.
    await this.deleteBuildSandbox(
      input.providerSessionId,
      {
        deleteSecretStore: true,
      },
      input.signal
    );
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(
      input.image.providerImageId,
      input.image.providerSessionId,
      ...(input.signal ? [input.signal] : [])
    );
  }

  private async deleteBuildSandbox(
    providerSessionId: string,
    options: { deleteSecretStore: boolean },
    signal?: AbortSignal
  ): Promise<void> {
    await this.provider.deleteSandbox(
      providerSessionId,
      {
        deleteSecretStore: options.deleteSecretStore,
      },
      ...(signal ? [signal] : [])
    );
  }
}
