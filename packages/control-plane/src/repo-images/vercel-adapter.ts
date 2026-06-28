import { createLogger } from "../logger";
import type { VercelSandboxProvider } from "../sandbox/providers/vercel/provider";
import type {
  DeleteRepoImageInput,
  FailedRepoImageBuildInput,
  FinalizeRepoImageBuildInput,
  FinalizeRepoImageBuildResult,
  RepoImageBuildAdapter,
  RepoImageBuildPlan,
  RepoImageBuildStartCallbacks,
  VercelRepoImageBuildPlan,
} from "./types";

const logger = createLogger("repo-images:vercel-adapter");

export class VercelRepoImageBuildAdapter implements RepoImageBuildAdapter {
  constructor(private readonly provider: VercelSandboxProvider) {}

  async startBuild(
    plan: RepoImageBuildPlan,
    callbacks: RepoImageBuildStartCallbacks
  ): Promise<void> {
    const vercelPlan = requireVercelPlan(plan);

    await this.provider.triggerRepoImageBuild({
      repoOwner: vercelPlan.repoOwner,
      repoName: vercelPlan.repoName,
      defaultBranch: vercelPlan.baseBranch,
      buildId: vercelPlan.buildId,
      callbackUrl: vercelPlan.callbackUrl,
      callbackToken: vercelPlan.callbackToken,
      userEnvVars: vercelPlan.userEnvVars,
      cloneToken:
        vercelPlan.cloneAuth.type === "credential_helper" ? vercelPlan.cloneAuth.token : undefined,
      buildTimeoutSeconds: vercelPlan.buildTimeoutSeconds,
      onProviderSessionCreated: callbacks.bindProviderSession,
      correlation: vercelPlan.correlation,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeRepoImageBuildInput
  ): Promise<FinalizeRepoImageBuildResult> {
    if (input.kind !== "provider_session") {
      throw new Error("provider_session_id is required for Vercel repo image completion");
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
        throw new Error(snapshot.error || "Vercel snapshot did not return an image id");
      }

      return {
        providerImageId: snapshot.imageId,
        providerSessionId: input.providerSessionId,
      };
    } finally {
      try {
        await this.stopBuildSandbox(input);
      } catch (error) {
        logger.warn("repo_image.vercel_build_stop_failed", {
          build_id: input.buildId,
          provider_session_id: input.providerSessionId,
          error: error instanceof Error ? error.message : String(error),
          request_id: input.correlation.request_id,
          trace_id: input.correlation.trace_id,
        });
      }
    }
  }

  async cleanupFailedBuild(input: FailedRepoImageBuildInput): Promise<void> {
    if (input.kind !== "provider_session") return;
    await this.stopBuildSandbox({
      buildId: input.buildId,
      providerSessionId: input.providerSessionId,
      correlation: input.correlation,
    });
  }

  async deleteImage(input: DeleteRepoImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.providerImageId);
  }

  private async stopBuildSandbox(input: {
    buildId: string;
    providerSessionId?: string;
    correlation: FinalizeRepoImageBuildInput["correlation"];
  }): Promise<void> {
    if (!input.providerSessionId) return;

    const stopResult = await this.provider.stopSandbox({
      providerObjectId: input.providerSessionId,
      sessionId: input.buildId,
      reason: "repo_image_build_complete",
      correlation: {
        ...input.correlation,
        sandbox_id: input.providerSessionId,
      },
    });

    if (!stopResult.success) {
      throw new Error(stopResult.error || "Failed to stop Vercel build sandbox");
    }
  }
}

function requireVercelPlan(plan: RepoImageBuildPlan): VercelRepoImageBuildPlan {
  if (plan.provider !== "vercel") {
    throw new Error(`Vercel adapter received ${plan.provider} repo image build plan`);
  }
  return plan;
}
