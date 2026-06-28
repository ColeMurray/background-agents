import { RepoImageStore } from "../db/repo-images";
import type { RepoImageProvider } from "../db/repo-images";
import { createLogger, type CorrelationContext } from "../logger";
import type { Env } from "../types";
import { hashRepoImageCallbackToken } from "./auth";
import { getRepoImageBackend } from "./backend-policy";
import { RepoImageBuildPlanner } from "./planner";
import { createRepoImageBuildAdapter } from "./provider-factory";
import type {
  CompleteProviderSessionBuild,
  CompleteRepoImageBuild,
  FailRepoImageBuild,
  FinalizeRepoImageBuildResult,
  RepoImageBuildAdapter,
  RepoImageWorkflowContext,
  RepoImageWorkflowResult,
  ReplacedRepoImage,
} from "./types";

const logger = createLogger("repo-images:workflow");

type RepoImageBuildAdapterFactory = () => RepoImageBuildAdapter;
type PlanBuildInput = Parameters<RepoImageBuildPlanner["planBuild"]>[0];
type AdapterResolution =
  | { type: "ok"; adapter: RepoImageBuildAdapter }
  | {
      type: "unconfigured";
      result: Extract<RepoImageWorkflowResult, { type: "repo_image_provider_unconfigured" }>;
    };

interface RepoImageBuildPlannerLike {
  planBuild(params: PlanBuildInput): ReturnType<RepoImageBuildPlanner["planBuild"]>;
}

interface ReadyBuildCompletion {
  kind: "provider_image" | "provider_session";
  buildId: string;
  providerSessionId?: string;
  baseSha: string;
  buildDurationSeconds: number;
}

export interface AcceptBuildCompleteCommand {
  completion: CompleteRepoImageBuild;
  callbackToken?: string | null;
  context: RepoImageWorkflowContext;
}

export interface AcceptBuildFailedCommand {
  failure: FailRepoImageBuild;
  callbackToken?: string | null;
  context: RepoImageWorkflowContext;
}

export class RepoImageBuildWorkflow {
  constructor(
    private readonly env: Env,
    private readonly store: RepoImageStore,
    private readonly createAdapter: RepoImageBuildAdapterFactory,
    private readonly backend: RepoImageProvider,
    private readonly planner: RepoImageBuildPlannerLike = new RepoImageBuildPlanner(env, backend)
  ) {}

  async triggerBuild(
    owner: string,
    name: string,
    ctx: RepoImageWorkflowContext
  ): Promise<RepoImageWorkflowResult> {
    if (!this.env.WORKER_URL) {
      return { type: "repo_image_workflow_unavailable", message: "WORKER_URL not configured" };
    }

    const now = Date.now();
    const buildId = `img-${owner}-${name}-${now}`;

    try {
      const planned = await this.planner.planBuild({
        buildId,
        repoOwner: owner,
        repoName: name,
        now,
        callbackUrl: `${this.env.WORKER_URL}/repo-images/build-complete`,
        correlation: ctx,
      });
      if (planned.type === "repo_not_installed") {
        return { type: "repository_not_installed", message: planned.message };
      }
      if (planned.type === "failed") {
        return {
          type: "workflow_failed",
          operation: "trigger_build",
          message: planned.message,
        };
      }

      const adapterResolution = this.createAdapterForOperation("trigger_build", ctx, buildId);
      if (adapterResolution.type === "unconfigured") return adapterResolution.result;
      const { adapter } = adapterResolution;

      await this.store.registerBuild({
        id: buildId,
        repoOwner: owner,
        repoName: name,
        provider: this.backend,
        baseBranch: planned.registration.baseBranch,
        callbackTokenHash: planned.registration.callbackTokenHash,
        callbackTokenExpiresAt: planned.registration.callbackTokenExpiresAt,
      });

      await adapter.startBuild(planned.plan, {
        bindProviderSession: async (providerSessionId) => {
          const bound = await this.store.bindProviderSession(
            buildId,
            this.backend,
            providerSessionId
          );
          if (!bound) {
            throw new Error(`Failed to bind ${this.backend} build session`);
          }
        },
      });

      logger.info("repo_image.build_triggered", {
        build_id: buildId,
        repo_owner: owner,
        repo_name: name,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      return { type: "build_triggered", buildId };
    } catch (e) {
      try {
        await this.store.markBuildFailed(buildId, this.backend, errorMessage(e));
      } catch (markFailedError) {
        logger.warn("repo_image.trigger_mark_failed_error", {
          error: errorMessage(markFailedError),
          build_id: buildId,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
      }

      logger.error("repo_image.trigger_error", {
        error: errorMessage(e),
        repo_owner: owner,
        repo_name: name,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        type: "workflow_failed",
        operation: "trigger_build",
        message: "Failed to trigger build",
      };
    }
  }

  async acceptBuildComplete(command: AcceptBuildCompleteCommand): Promise<RepoImageWorkflowResult> {
    const { completion, context: ctx } = command;

    if (completion.kind === "provider_session") {
      const authError = await this.requireTokenBuildCallbackAuth(command.callbackToken, {
        buildId: completion.buildId,
        providerSessionId: completion.providerSessionId,
        ctx,
      });
      if (authError) return authError;

      logger.info("repo_image.build_complete_received", {
        build_id: completion.buildId,
        provider_session_id: completion.providerSessionId,
        base_sha: completion.baseSha,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      const finalization = this.finalizeAndCommit(
        {
          ...completion,
          correlation: ctx,
        },
        ctx
      );

      return { type: "completion_accepted", finalization };
    }

    const adapterResolution = this.createAdapterForOperation(
      "build_complete",
      ctx,
      completion.buildId
    );
    if (adapterResolution.type === "unconfigured") return adapterResolution.result;
    const { adapter } = adapterResolution;

    try {
      const finalized = await adapter.finalizeSuccessfulBuild({
        ...completion,
        correlation: ctx,
      });
      const result = await this.markFinalizedBuildReady({
        adapter,
        completion,
        finalized,
        ctx,
        startedAt: Date.now(),
        deleteFinalizedImageOnReject: true,
      });
      if (!result.updated) {
        return { type: "completion_not_accepted", message: "Build is not accepting completion" };
      }
      return result.cleanup
        ? { type: "build_ready", replacedImages: result.replacedImages, cleanup: result.cleanup }
        : { type: "build_ready", replacedImages: result.replacedImages };
    } catch (e) {
      logger.error("repo_image.build_complete_error", {
        error: errorMessage(e),
        build_id: completion.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        type: "workflow_failed",
        operation: "build_complete",
        message: "Failed to mark build as ready",
      };
    }
  }

  async acceptBuildFailed(command: AcceptBuildFailedCommand): Promise<RepoImageWorkflowResult> {
    const { failure, context: ctx } = command;

    if (failure.kind === "provider_session") {
      const authError = await this.requireTokenBuildCallbackAuth(command.callbackToken, {
        buildId: failure.buildId,
        providerSessionId: failure.providerSessionId,
        ctx,
      });
      if (authError) return authError;
    }

    try {
      const updated = await this.store.markBuildFailed(
        failure.buildId,
        this.backend,
        failure.errorMessage
      );
      if (!updated) {
        return { type: "failure_not_accepted", message: "Build is not accepting failure" };
      }

      logger.info("repo_image.build_failed", {
        build_id: failure.buildId,
        error_message: failure.errorMessage,
        provider_session_id: failure.kind === "provider_session" ? failure.providerSessionId : null,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      const cleanup = this.cleanupFailedBuild(failure, ctx);
      return cleanup ? { type: "build_failed", cleanup } : { type: "build_failed" };
    } catch (e) {
      logger.error("repo_image.build_failed_error", {
        error: errorMessage(e),
        build_id: failure.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        type: "workflow_failed",
        operation: "build_failed",
        message: "Failed to mark build as failed",
      };
    }
  }

  private createAdapterForOperation(
    operation: string,
    ctx: RepoImageWorkflowContext,
    buildId?: string
  ): AdapterResolution {
    try {
      return { type: "ok", adapter: this.createAdapter() };
    } catch (e) {
      logger.error("repo_image.adapter_config_error", {
        operation,
        build_id: buildId,
        provider: this.backend,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        type: "unconfigured",
        result: {
          type: "repo_image_provider_unconfigured",
          message: "Repo image provider is not configured",
        },
      };
    }
  }

  private createAdapterForBestEffortCleanup(
    buildId: string,
    providerSessionId: string | null | undefined,
    ctx: RepoImageWorkflowContext
  ): RepoImageBuildAdapter | null {
    try {
      return this.createAdapter();
    } catch (e) {
      logger.warn("repo_image.cleanup_adapter_unavailable", {
        build_id: buildId,
        provider_session_id: providerSessionId,
        provider: this.backend,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return null;
    }
  }

  private async requireTokenBuildCallbackAuth(
    token: string | null | undefined,
    params: { buildId: string; providerSessionId: string; ctx: RepoImageWorkflowContext }
  ): Promise<RepoImageWorkflowResult | null> {
    if (!token) {
      logger.warn("repo_image.callback_auth_failed", {
        build_id: params.buildId,
        provider_session_id: params.providerSessionId,
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      return { type: "callback_auth_rejected", message: "Unauthorized" };
    }

    let tokenHash: string;
    try {
      tokenHash = await hashRepoImageCallbackToken(token, this.env);
    } catch (e) {
      logger.error("repo_image.callback_auth_misconfigured", {
        build_id: params.buildId,
        error: errorMessage(e),
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      return {
        type: "callback_auth_unavailable",
        message: "Internal authentication not configured",
      };
    }

    const build = await this.store.consumeCallbackToken({
      buildId: params.buildId,
      provider: this.backend,
      providerSessionId: params.providerSessionId,
      tokenHash,
      now: Date.now(),
    });

    if (!build) {
      logger.warn("repo_image.callback_auth_failed", {
        build_id: params.buildId,
        provider_session_id: params.providerSessionId,
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      return { type: "callback_auth_rejected", message: "Unauthorized" };
    }

    return null;
  }

  private async finalizeAndCommit(
    input: CompleteProviderSessionBuild & {
      correlation: CorrelationContext;
    },
    ctx: RepoImageWorkflowContext
  ): Promise<void> {
    const startedAt = Date.now();
    let finalizedProviderImageId: string | null = null;
    let adapter: RepoImageBuildAdapter | null = null;

    try {
      adapter = this.createAdapter();
      logger.info(`repo_image.${this.backend}_finalize_start`, {
        build_id: input.buildId,
        provider_session_id: input.providerSessionId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      const finalized = await adapter.finalizeSuccessfulBuild(input);
      finalizedProviderImageId = finalized.providerImageId;

      const result = await this.markFinalizedBuildReady({
        adapter,
        completion: input,
        finalized,
        ctx,
        startedAt,
        deleteFinalizedImageOnReject: true,
      });
      await result.cleanup;
    } catch (e) {
      const message = errorMessage(e);
      if (finalizedProviderImageId && adapter) {
        await this.deleteImageBestEffort(
          finalizedProviderImageId,
          input.providerSessionId,
          ctx,
          adapter
        );
      }
      try {
        await this.store.markBuildFailed(input.buildId, this.backend, message);
      } catch (markFailedError) {
        logger.error("repo_image.mark_failed_after_finalize_error", {
          build_id: input.buildId,
          error: errorMessage(markFailedError),
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
      }
      logger.error(`repo_image.${this.backend}_finalize_error`, {
        build_id: input.buildId,
        provider_session_id: input.providerSessionId,
        error: message,
        duration_ms: Date.now() - startedAt,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }
  }

  private deleteReplacedImages(
    adapter: RepoImageBuildAdapter,
    replacedImages: ReplacedRepoImage[],
    ctx: RepoImageWorkflowContext
  ): Promise<void> | undefined {
    if (replacedImages.length === 0) return undefined;

    return Promise.all(
      replacedImages.map((image) =>
        this.deleteImageBestEffort(image.providerImageId, image.providerSessionId, ctx, adapter)
      )
    ).then(() => undefined);
  }

  private async markFinalizedBuildReady(params: {
    adapter: RepoImageBuildAdapter;
    completion: ReadyBuildCompletion;
    finalized: FinalizeRepoImageBuildResult;
    ctx: RepoImageWorkflowContext;
    startedAt: number;
    deleteFinalizedImageOnReject: boolean;
  }): Promise<{
    updated: boolean;
    replacedImageId: string | null;
    replacedProviderSessionId: string | null;
    replacedImages: ReplacedRepoImage[];
    cleanup?: Promise<void>;
  }> {
    const result = await this.store.markBuildReady(
      params.completion.buildId,
      this.backend,
      params.finalized.providerImageId,
      params.completion.baseSha,
      params.completion.buildDurationSeconds
    );

    if (!result.updated) {
      if (params.deleteFinalizedImageOnReject) {
        await this.deleteImageBestEffort(
          params.finalized.providerImageId,
          params.finalized.providerSessionId,
          params.ctx,
          params.adapter
        );
      }

      logger.warn(`repo_image.${this.backend}_finalize_not_applied`, {
        build_id: params.completion.buildId,
        provider_session_id: params.completion.providerSessionId,
        provider_image_id: params.finalized.providerImageId,
        duration_ms: Date.now() - params.startedAt,
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      return result;
    }

    logger.info("repo_image.build_complete", {
      build_id: params.completion.buildId,
      provider_image_id: params.finalized.providerImageId,
      provider_session_id: params.completion.providerSessionId,
      base_sha: params.completion.baseSha,
      replaced_image_id: result.replacedImageId,
      snapshot_duration_ms: Date.now() - params.startedAt,
      request_id: params.ctx.request_id,
      trace_id: params.ctx.trace_id,
    });

    const cleanup = this.deleteReplacedImages(params.adapter, result.replacedImages, params.ctx);
    return cleanup ? { ...result, cleanup } : result;
  }

  private cleanupFailedBuild(
    failure: FailRepoImageBuild,
    ctx: RepoImageWorkflowContext
  ): Promise<void> | undefined {
    if (failure.kind !== "provider_session") return undefined;

    const adapter = this.createAdapterForBestEffortCleanup(
      failure.buildId,
      failure.providerSessionId,
      ctx
    );
    if (!adapter?.cleanupFailedBuild) return undefined;

    return adapter
      .cleanupFailedBuild({
        ...failure,
        correlation: ctx,
      })
      .catch((e) => {
        logger.warn(`repo_image.${this.backend}_build_cleanup_failed`, {
          build_id: failure.buildId,
          provider_session_id: failure.providerSessionId,
          error: errorMessage(e),
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
      });
  }

  private async deleteImageBestEffort(
    providerImageId: string,
    providerSessionId: string | null | undefined,
    ctx: RepoImageWorkflowContext,
    adapter: RepoImageBuildAdapter
  ): Promise<void> {
    try {
      await adapter.deleteImage({
        providerImageId,
        providerSessionId,
        correlation: ctx,
      });
    } catch (e) {
      logger.warn("repo_image.delete_old_failed", {
        provider_image_id: providerImageId,
        error: errorMessage(e),
      });
    }
  }
}

export function createRepoImageBuildWorkflowFromEnv(env: Env): RepoImageBuildWorkflow {
  return new RepoImageBuildWorkflow(
    env,
    new RepoImageStore(env.DB),
    () => createRepoImageBuildAdapter(env),
    getRepoImageBackend(env)
  );
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
