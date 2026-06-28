import { createLogger } from "../logger";
import type { OpenComputerSandboxProvider } from "../sandbox/providers/opencomputer-provider";
import type {
  DeleteRepoImageInput,
  FailedRepoImageBuildInput,
  FinalizeRepoImageBuildInput,
  FinalizeRepoImageBuildResult,
  OpenComputerRepoImageBuildPlan,
  RepoImageBuildAdapter,
  RepoImageBuildPlan,
  RepoImageBuildStartCallbacks,
} from "./types";

const logger = createLogger("repo-images:opencomputer-adapter");

export class OpenComputerRepoImageBuildAdapter implements RepoImageBuildAdapter {
  constructor(private readonly provider: OpenComputerSandboxProvider) {}

  async startBuild(
    plan: RepoImageBuildPlan,
    callbacks: RepoImageBuildStartCallbacks
  ): Promise<void> {
    const openComputerPlan = requireOpenComputerPlan(plan);

    await this.provider.triggerRepoImageBuild({
      repoOwner: openComputerPlan.repoOwner,
      repoName: openComputerPlan.repoName,
      defaultBranch: openComputerPlan.baseBranch,
      buildId: openComputerPlan.buildId,
      callbackUrl: openComputerPlan.callbackUrl,
      callbackToken: openComputerPlan.callbackToken,
      userEnvVars: openComputerPlan.userEnvVars,
      buildTimeoutSeconds: openComputerPlan.buildTimeoutSeconds,
      onProviderSessionCreated: callbacks.bindProviderSession,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeRepoImageBuildInput
  ): Promise<FinalizeRepoImageBuildResult> {
    if (input.kind !== "provider_session") {
      throw new Error("provider_session_id is required for OpenComputer repo image completion");
    }

    try {
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
    } finally {
      await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
    }
  }

  async cleanupFailedBuild(input: FailedRepoImageBuildInput): Promise<void> {
    if (input.kind !== "provider_session") return;
    await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
  }

  async deleteImage(input: DeleteRepoImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.providerImageId, input.providerSessionId);
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

function requireOpenComputerPlan(plan: RepoImageBuildPlan): OpenComputerRepoImageBuildPlan {
  if (plan.provider !== "opencomputer") {
    throw new Error(`OpenComputer adapter received ${plan.provider} repo image build plan`);
  }
  return plan;
}
