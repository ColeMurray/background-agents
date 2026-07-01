import { createLogger } from "../logger";
import type { OpenComputerSandboxProvider } from "../sandbox/providers/opencomputer-provider";
import type {
  CleanupCompletedProviderSessionBuildInput,
  DeleteRepoImageInput,
  FailedRepoImageBuildInput,
  FinalizeRepoImageBuildInput,
  FinalizeRepoImageBuildResult,
  OpenComputerRepoImageBuildPlan,
  RepoImageBuildAdapter,
  RepoImageBuildStartCallbacks,
} from "./types";

const logger = createLogger("repo-images:opencomputer-adapter");
const MS_PER_SECOND = 1000;

/**
 * OpenComputer adapter for provider-session repo image builds.
 *
 * Builds run in a temporary OpenComputer sandbox. On success, the adapter
 * checkpoints that sandbox into the repo image artifact and deletes the build sandbox.
 */
export class OpenComputerRepoImageBuildAdapter implements RepoImageBuildAdapter<OpenComputerRepoImageBuildPlan> {
  constructor(private readonly provider: OpenComputerSandboxProvider) {}

  async startBuild(
    openComputerPlan: OpenComputerRepoImageBuildPlan,
    callbacks: RepoImageBuildStartCallbacks
  ): Promise<void> {
    await this.provider.triggerRepoImageBuild({
      repoOwner: openComputerPlan.repoOwner,
      repoName: openComputerPlan.repoName,
      defaultBranch: openComputerPlan.baseBranch,
      buildId: openComputerPlan.buildId,
      callbackUrl: openComputerPlan.callbackUrl,
      callbackToken: openComputerPlan.callbackToken,
      userEnvVars: openComputerPlan.userEnvVars,
      buildTimeoutSeconds: Math.ceil(openComputerPlan.buildTimeoutMs / MS_PER_SECOND),
      onProviderSessionCreated: callbacks.bindProviderSession,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeRepoImageBuildInput
  ): Promise<FinalizeRepoImageBuildResult> {
    if (input.kind !== "provider_session") {
      throw new Error("provider_session_id is required for OpenComputer repo image completion");
    }

    const snapshot = await this.provider.takeSnapshot({
      providerObjectId: input.providerSessionId,
      sessionId: input.buildId,
      reason: "repo_image_build",
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

  async cleanupCompletedBuild(input: CleanupCompletedProviderSessionBuildInput): Promise<void> {
    await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
  }

  async cleanupFailedBuild(input: FailedRepoImageBuildInput): Promise<void> {
    if (input.kind !== "provider_session") return;
    await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
  }

  async deleteImage(input: DeleteRepoImageInput): Promise<void> {
    await this.provider.deleteProviderImage(
      input.image.providerImageId,
      input.image.providerSessionId
    );
  }

  private async deleteBuildSandbox(
    buildId: string,
    providerSessionId: string | null | undefined,
    correlation: FinalizeRepoImageBuildInput["correlation"]
  ): Promise<void> {
    if (!providerSessionId) return;
    try {
      await this.provider.deleteSandbox(providerSessionId);
    } catch (error) {
      logger.warn("repo_image.opencomputer_build_cleanup_failed", {
        build_id: buildId,
        provider_session_id: providerSessionId,
        error: error instanceof Error ? error.message : String(error),
        request_id: correlation.request_id,
        trace_id: correlation.trace_id,
      });
    }
  }
}
