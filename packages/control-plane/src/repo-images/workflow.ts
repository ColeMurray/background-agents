import { generateId } from "../auth/crypto";
import { verifyInternalToken } from "../auth/internal";
import { RepoImageStore } from "../db/repo-images";
import type { RepoImageBuild } from "../db/repo-images";
import { createLogger, type CorrelationContext } from "../logger";
import type { Env } from "../types";
import { hashRepoImageCallbackToken } from "./auth";
import {
  RepoImageBuildCompleteFailedError,
  RepoImageBuildFailedUpdateError,
  RepoImageCallbackAuthRejectedError,
  RepoImageCallbackAuthUnavailableError,
  RepoImageCompletionNotAcceptedError,
  RepoImageFailureNotAcceptedError,
  RepoImageInvalidCallbackError,
  RepoImagePlanningError,
  RepoImageProviderUnconfiguredError,
  RepoImageRepositoryNotInstalledError,
  RepoImageTriggerFailedError,
  RepoImageWorkflowUnavailableError,
} from "./errors";
import type { RepoImageCallbackBuild, RepoImageProvider } from "./model";
import { getRepoImageCallbackMode, resolveRepoImageProvider } from "./provider-policy";
import { RepoImageBuildPlanner } from "./planner";
import {
  createRepoImageBuildAdapterFactory,
  type RepoImageBuildAdapterFactory,
} from "./provider-factory";
import type {
  AnyRepoImageBuildAdapter,
  CompleteProviderSessionBuild,
  CompleteRepoImageBuild,
  CompleteRepoImageBuildCallback,
  FailRepoImageBuild,
  FailRepoImageBuildCallback,
  FinalizeRepoImageBuildResult,
  PlannedRepoImageBuild,
  RepoImageBuildPlan,
  RepoImageBuildFinalizer,
  RepoImageBuildStartCallbacks,
  TriggerRepoImageBuildResult,
  RepoImageWorkflowContext,
  RepoImageWorkflowResult,
  ReplacedRepoImage,
} from "./types";

const logger = createLogger("repo-images:workflow");

type PlanBuildInput = Parameters<RepoImageBuildPlanner["planBuild"]>[0];
type PlannedBuildStart = {
  adapter: AnyRepoImageBuildAdapter;
  start(callbacks: {
    bindProviderSession(providerSessionId: string): Promise<void>;
  }): Promise<void>;
};
type FinalizedReadyResult =
  | { type: "ready"; replacedImages: ReplacedRepoImage[]; cleanup?: Promise<void> }
  | { type: "superseded"; cleanup?: Promise<void> }
  | { type: "not_accepting" };
type BoundRepoImageBuildAdapter = RepoImageBuildFinalizer & {
  startBuild(plan: RepoImageBuildPlan, callbacks: RepoImageBuildStartCallbacks): Promise<void>;
};

interface RepoImageBuildPlannerLike {
  planBuild(params: PlanBuildInput): ReturnType<RepoImageBuildPlanner["planBuild"]>;
}

interface ReadyBuildCompletion {
  kind: "provider_image" | "provider_session";
  buildId: string;
  providerSessionId?: string;
  baseSha: string;
  buildDurationMs: number;
}

export interface AcceptBuildCompleteCommand {
  completion: CompleteRepoImageBuildCallback;
  authorizationHeader?: string | null;
  callbackToken?: string | null;
  context: RepoImageWorkflowContext;
}

export interface AcceptBuildFailedCommand {
  failure: FailRepoImageBuildCallback;
  authorizationHeader?: string | null;
  callbackToken?: string | null;
  context: RepoImageWorkflowContext;
}

// Workflow methods return successful domain outcomes and throw RepoImageError subclasses for
// route-level error mapping.
export class RepoImageBuildWorkflow {
  private readonly planner: RepoImageBuildPlannerLike | null;

  constructor(
    private readonly env: Env,
    private readonly store: RepoImageStore,
    private readonly adapterFactory: RepoImageBuildAdapterFactory,
    private readonly provider: RepoImageProvider | null,
    planner?: RepoImageBuildPlannerLike
  ) {
    this.planner = planner ?? (provider ? new RepoImageBuildPlanner(env, provider) : null);
  }

  async triggerBuild(
    owner: string,
    name: string,
    ctx: RepoImageWorkflowContext
  ): Promise<TriggerRepoImageBuildResult> {
    if (!this.provider || !this.planner) {
      throw new RepoImageWorkflowUnavailableError("Repo image provider is not configured");
    }
    if (!this.env.WORKER_URL) {
      throw new RepoImageWorkflowUnavailableError("WORKER_URL not configured");
    }

    const provider = this.provider;
    const now = Date.now();
    const buildId = createBuildId(owner, name, now);
    const callbackUrl = `${this.env.WORKER_URL}/repo-images/build-complete`;
    let build: PlannedRepoImageBuild;
    let start: PlannedBuildStart;

    try {
      build = await this.planner.planBuild({
        buildId,
        repoOwner: owner,
        repoName: name,
        now,
        callbackUrl,
        correlation: ctx,
      });
      start = this.preparePlannedBuildStart(build, ctx);
    } catch (e) {
      if (
        e instanceof RepoImageRepositoryNotInstalledError ||
        e instanceof RepoImagePlanningError ||
        e instanceof RepoImageProviderUnconfiguredError
      ) {
        throw e;
      }

      logger.error("repo_image.trigger_error", {
        error: errorMessage(e),
        repo_owner: owner,
        repo_name: name,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new RepoImageTriggerFailedError("Failed to trigger build", e);
    }

    let providerSessionIdForCleanup: string | null = null;
    try {
      await this.store.registerBuild({
        id: buildId,
        repoOwner: owner,
        repoName: name,
        provider,
        baseBranch: build.plan.baseBranch,
        ...callbackAuthRegistration(build),
      });

      await start.start({
        bindProviderSession: async (providerSessionId) => {
          providerSessionIdForCleanup = providerSessionId;
          const bound = await this.store.bindProviderSession(buildId, provider, providerSessionId);
          if (!bound) {
            throw new Error(`Failed to bind ${provider} build session`);
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

      return { buildId };
    } catch (e) {
      if (providerSessionIdForCleanup && start.adapter.cleanupFailedBuild) {
        await start.adapter
          .cleanupFailedBuild({
            kind: "provider_session",
            buildId,
            providerSessionId: providerSessionIdForCleanup,
            errorMessage: errorMessage(e),
            correlation: ctx,
          })
          .catch((cleanupError) => {
            logger.warn(`repo_image.${provider}_trigger_cleanup_failed`, {
              build_id: buildId,
              provider_session_id: providerSessionIdForCleanup,
              error: errorMessage(cleanupError),
              request_id: ctx.request_id,
              trace_id: ctx.trace_id,
            });
          });
      }

      try {
        await this.store.markBuildFailed(buildId, provider, errorMessage(e));
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
      throw new RepoImageTriggerFailedError("Failed to trigger build", e);
    }
  }

  async acceptBuildComplete(command: AcceptBuildCompleteCommand): Promise<RepoImageWorkflowResult> {
    const { completion, context: ctx } = command;
    const build = await this.store.getCallbackBuild(completion.buildId);
    if (!build) {
      throw new RepoImageCompletionNotAcceptedError("Build is not accepting completion");
    }

    const provider = build.provider;
    let readyCompletion: CompleteRepoImageBuild;

    if (getRepoImageCallbackMode(provider) === "provider_session") {
      readyCompletion = this.buildReadyCompletion(provider, completion);
      if (readyCompletion.kind !== "provider_session") {
        throw new RepoImageBuildCompleteFailedError("Invalid provider-session completion");
      }

      await this.authorizeRepoImageCallback(build, {
        providerSessionId: readyCompletion.providerSessionId,
        callbackToken: command.callbackToken,
        ctx,
      });

      logger.info("repo_image.build_complete_received", {
        build_id: readyCompletion.buildId,
        provider,
        provider_session_id: readyCompletion.providerSessionId,
        base_sha: readyCompletion.baseSha,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      const finalization = this.finalizeAndCommit(
        provider,
        {
          ...readyCompletion,
          correlation: ctx,
        },
        ctx
      );

      return { type: "completion_accepted", finalization };
    }

    await this.authorizeRepoImageCallback(build, {
      authorizationHeader: command.authorizationHeader,
      ctx,
    });

    readyCompletion = this.buildReadyCompletion(provider, completion);
    if (readyCompletion.kind !== "provider_image") {
      throw new RepoImageBuildCompleteFailedError("Invalid provider-image completion");
    }

    if (build.status !== "building") {
      throw new RepoImageCompletionNotAcceptedError("Build is not accepting completion");
    }

    const adapter = this.createAdapterForOperation(
      provider,
      "build_complete",
      ctx,
      readyCompletion.buildId
    );

    let finalized: FinalizeRepoImageBuildResult | null = null;
    try {
      finalized = await adapter.finalizeSuccessfulBuild({
        ...readyCompletion,
        correlation: ctx,
      });
      const result = await this.markFinalizedBuildReady(provider, {
        adapter,
        completion: readyCompletion,
        finalized,
        ctx,
        startedAt: Date.now(),
        deleteFinalizedImageOnReject: false,
      });

      switch (result.type) {
        case "ready":
          return result.cleanup
            ? {
                type: "build_ready",
                replacedImages: result.replacedImages,
                cleanup: result.cleanup,
              }
            : { type: "build_ready", replacedImages: result.replacedImages };
        case "superseded":
          return result.cleanup
            ? { type: "build_superseded", cleanup: result.cleanup }
            : { type: "build_superseded" };
        case "not_accepting":
          throw new RepoImageCompletionNotAcceptedError("Build is not accepting completion");
      }
    } catch (e) {
      if (e instanceof RepoImageCompletionNotAcceptedError) throw e;

      logger.error("repo_image.build_complete_error", {
        error: errorMessage(e),
        build_id: readyCompletion.buildId,
        finalized_image_id: finalized?.providerImageId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new RepoImageBuildCompleteFailedError("Failed to mark build as ready", e);
    }
  }

  async acceptBuildFailed(command: AcceptBuildFailedCommand): Promise<RepoImageWorkflowResult> {
    const { failure, context: ctx } = command;
    const build = await this.store.getCallbackBuild(failure.buildId);
    if (!build) {
      throw new RepoImageFailureNotAcceptedError("Build is not accepting failure");
    }

    const provider = await this.authorizeRepoImageCallback(build, {
      providerSessionId: failure.providerSessionId,
      authorizationHeader: command.authorizationHeader,
      callbackToken: command.callbackToken,
      ctx,
    });
    const failureInput = this.buildFailureInput(provider, failure);

    let updated: boolean;
    try {
      updated = await this.store.markBuildFailed(
        failureInput.buildId,
        provider,
        failureInput.errorMessage
      );
    } catch (e) {
      logger.error("repo_image.build_failed_error", {
        error: errorMessage(e),
        build_id: failure.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new RepoImageBuildFailedUpdateError("Failed to mark build as failed", e);
    }

    if (!updated) {
      throw new RepoImageFailureNotAcceptedError("Build is not accepting failure");
    }

    logger.info("repo_image.build_failed", {
      build_id: failureInput.buildId,
      provider,
      error_message: failureInput.errorMessage,
      provider_session_id:
        failureInput.kind === "provider_session" ? failureInput.providerSessionId : null,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    const cleanup = this.cleanupFailedBuild(provider, failureInput, ctx);
    return cleanup ? { type: "build_failed", cleanup } : { type: "build_failed" };
  }

  private buildFailureInput(
    provider: RepoImageProvider,
    failure: FailRepoImageBuildCallback
  ): FailRepoImageBuild {
    if (getRepoImageCallbackMode(provider) === "provider_session") {
      if (!failure.providerSessionId) {
        throw new RepoImageInvalidCallbackError("provider_session_id is required");
      }
      return {
        kind: "provider_session",
        buildId: failure.buildId,
        providerSessionId: failure.providerSessionId,
        errorMessage: failure.errorMessage,
      };
    }

    return {
      kind: "provider_image",
      buildId: failure.buildId,
      errorMessage: failure.errorMessage,
    };
  }

  private buildReadyCompletion(
    provider: RepoImageProvider,
    completion: CompleteRepoImageBuildCallback
  ): CompleteRepoImageBuild {
    if (!completion.baseSha) {
      throw new RepoImageInvalidCallbackError("base_sha is required");
    }
    if (typeof completion.buildDurationMs !== "number") {
      throw new RepoImageInvalidCallbackError("build_duration_seconds is required");
    }
    if (!Number.isFinite(completion.buildDurationMs) || completion.buildDurationMs < 0) {
      throw new RepoImageInvalidCallbackError(
        "build_duration_seconds must be a non-negative finite number"
      );
    }

    if (getRepoImageCallbackMode(provider) === "provider_session") {
      if (!completion.providerSessionId) {
        throw new RepoImageInvalidCallbackError("provider_session_id is required");
      }

      return {
        kind: "provider_session",
        buildId: completion.buildId,
        providerSessionId: completion.providerSessionId,
        baseSha: completion.baseSha,
        buildDurationMs: completion.buildDurationMs,
      };
    }

    if (!completion.providerImageId) {
      throw new RepoImageInvalidCallbackError("provider_image_id is required");
    }

    return {
      kind: "provider_image",
      buildId: completion.buildId,
      providerImageId: completion.providerImageId,
      baseSha: completion.baseSha,
      buildDurationMs: completion.buildDurationMs,
    };
  }

  private createAdapterForOperation(
    provider: RepoImageProvider,
    operation: string,
    ctx: RepoImageWorkflowContext,
    buildId?: string
  ): AnyRepoImageBuildAdapter {
    return this.createAdapter(
      provider,
      operation,
      ctx,
      () => this.adapterFactory.create(provider),
      buildId
    );
  }

  private createAdapter<TAdapter extends RepoImageBuildFinalizer>(
    provider: RepoImageProvider,
    operation: string,
    ctx: RepoImageWorkflowContext,
    create: () => TAdapter,
    buildId?: string
  ): TAdapter {
    try {
      return create();
    } catch (e) {
      logger.error("repo_image.adapter_config_error", {
        operation,
        build_id: buildId,
        provider,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new RepoImageProviderUnconfiguredError("Repo image provider is not configured", e);
    }
  }

  private preparePlannedBuildStart(
    build: PlannedRepoImageBuild,
    ctx: RepoImageWorkflowContext
  ): PlannedBuildStart {
    const plan = build.plan;
    const adapter = this.createAdapterForOperation(
      plan.provider,
      "trigger_build",
      ctx,
      plan.buildId
    );
    return this.bindPlannedBuildStart(plan, adapter);
  }

  private bindPlannedBuildStart(
    plan: RepoImageBuildPlan,
    adapter: AnyRepoImageBuildAdapter
  ): PlannedBuildStart {
    const boundAdapter = adapter as BoundRepoImageBuildAdapter;
    return {
      adapter,
      start: (callbacks) => boundAdapter.startBuild(plan, callbacks),
    };
  }

  private createAdapterForBestEffortCleanup(
    provider: RepoImageProvider,
    buildId: string,
    ctx: RepoImageWorkflowContext
  ): AnyRepoImageBuildAdapter | null {
    try {
      return this.createAdapterForOperation(provider, "cleanup", ctx, buildId);
    } catch (e) {
      if (e instanceof RepoImageProviderUnconfiguredError) return null;
      throw e;
    }
  }

  private async authorizeRepoImageCallback(
    build: RepoImageCallbackBuild,
    params: {
      providerSessionId?: string;
      authorizationHeader?: string | null;
      callbackToken?: string | null;
      ctx: RepoImageWorkflowContext;
    }
  ): Promise<RepoImageProvider> {
    if (getRepoImageCallbackMode(build.provider) === "provider_image") {
      await this.requireInternalBuildCallbackAuth(params.authorizationHeader, build.id, params.ctx);
      return build.provider;
    }

    if (!params.providerSessionId) {
      throw new RepoImageInvalidCallbackError("provider_session_id is required");
    }

    await this.requireTokenBuildCallbackAuth(params.callbackToken, {
      buildId: build.id,
      provider: build.provider,
      providerSessionId: params.providerSessionId,
      ctx: params.ctx,
    });
    return build.provider;
  }

  private async requireInternalBuildCallbackAuth(
    authorizationHeader: string | null | undefined,
    buildId: string,
    ctx: RepoImageWorkflowContext
  ): Promise<void> {
    if (!this.env.INTERNAL_CALLBACK_SECRET) {
      logger.error("repo_image.callback_auth_misconfigured", {
        build_id: buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new RepoImageCallbackAuthUnavailableError("Internal authentication not configured");
    }

    const authorized = await verifyInternalToken(
      authorizationHeader ?? null,
      this.env.INTERNAL_CALLBACK_SECRET
    );
    if (authorized) return;

    logger.warn("repo_image.callback_auth_failed", {
      build_id: buildId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    throw new RepoImageCallbackAuthRejectedError("Unauthorized");
  }

  private async requireTokenBuildCallbackAuth(
    token: string | null | undefined,
    params: {
      buildId: string;
      provider: RepoImageProvider;
      providerSessionId: string;
      ctx: RepoImageWorkflowContext;
    }
  ): Promise<void> {
    if (!token) {
      logger.warn("repo_image.callback_auth_failed", {
        build_id: params.buildId,
        provider: params.provider,
        provider_session_id: params.providerSessionId,
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      throw new RepoImageCallbackAuthRejectedError("Unauthorized");
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
      throw new RepoImageCallbackAuthUnavailableError("Internal authentication not configured");
    }

    const build = await this.store.consumeCallbackToken({
      buildId: params.buildId,
      provider: params.provider,
      providerSessionId: params.providerSessionId,
      tokenHash,
      now: Date.now(),
    });

    if (!build) {
      logger.warn("repo_image.callback_auth_failed", {
        build_id: params.buildId,
        provider: params.provider,
        provider_session_id: params.providerSessionId,
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      throw new RepoImageCallbackAuthRejectedError("Unauthorized");
    }
  }

  private async finalizeAndCommit(
    provider: RepoImageProvider,
    input: CompleteProviderSessionBuild & {
      correlation: CorrelationContext;
    },
    ctx: RepoImageWorkflowContext
  ): Promise<void> {
    const startedAt = Date.now();
    let finalized: FinalizeRepoImageBuildResult | null = null;
    let adapter: AnyRepoImageBuildAdapter | null = null;

    try {
      adapter = this.createAdapterForOperation(provider, "build_complete", ctx, input.buildId);
      logger.info(`repo_image.${provider}_finalize_start`, {
        build_id: input.buildId,
        provider_session_id: input.providerSessionId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      finalized = await adapter.finalizeSuccessfulBuild(input);

      const result = await this.markFinalizedBuildReady(provider, {
        adapter,
        completion: input,
        finalized,
        ctx,
        startedAt,
        deleteFinalizedImageOnReject: true,
      });
      if (result.type !== "not_accepting") {
        await result.cleanup;
      }
      await this.cleanupCompletedBuild(provider, adapter, input, ctx);
    } catch (e) {
      const message = errorMessage(e);
      if (adapter) {
        await this.cleanupCompletedBuild(provider, adapter, input, ctx);
      }
      if (!finalized) {
        try {
          await this.store.markBuildFailed(input.buildId, provider, message);
        } catch (markFailedError) {
          logger.error("repo_image.mark_failed_after_finalize_error", {
            build_id: input.buildId,
            error: errorMessage(markFailedError),
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          });
        }
      }
      logger.error(`repo_image.${provider}_finalize_error`, {
        build_id: input.buildId,
        provider_session_id: input.providerSessionId,
        provider_image_id: finalized?.providerImageId,
        error: message,
        duration_ms: Date.now() - startedAt,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }
  }

  private deleteReplacedImages(
    adapter: RepoImageBuildFinalizer,
    replacedImages: ReplacedRepoImage[],
    ctx: RepoImageWorkflowContext
  ): Promise<void> | undefined {
    if (replacedImages.length === 0) return undefined;

    return Promise.all(
      replacedImages.map(async (replacedImage) => {
        const deleted = await this.deleteImageBestEffort(replacedImage.image, ctx, adapter);
        if (deleted) {
          try {
            await this.store.deleteSupersededImage(replacedImage.repoImageId);
          } catch (e) {
            logger.warn("repo_image.delete_superseded_row_failed", {
              repo_image_id: replacedImage.repoImageId,
              provider_image_id: replacedImage.image.providerImageId,
              error: errorMessage(e),
              request_id: ctx.request_id,
              trace_id: ctx.trace_id,
            });
          }
        }
      })
    ).then(() => undefined);
  }

  private async markFinalizedBuildReady(
    provider: RepoImageProvider,
    params: {
      adapter: RepoImageBuildFinalizer;
      completion: ReadyBuildCompletion;
      finalized: FinalizeRepoImageBuildResult;
      ctx: RepoImageWorkflowContext;
      startedAt: number;
      deleteFinalizedImageOnReject: boolean;
    }
  ): Promise<FinalizedReadyResult> {
    const result = await this.store.tryMarkRepoImageReady(
      params.completion.buildId,
      provider,
      params.finalized.providerImageId,
      params.completion.baseSha,
      params.completion.buildDurationMs
    );

    if (result.type === "not_accepting_completion") {
      if (params.deleteFinalizedImageOnReject) {
        await this.deleteImageBestEffort(params.finalized, params.ctx, params.adapter);
      }

      logger.warn(`repo_image.${provider}_finalize_not_applied`, {
        build_id: params.completion.buildId,
        provider_session_id: params.completion.providerSessionId,
        provider_image_id: params.finalized.providerImageId,
        duration_ms: Date.now() - params.startedAt,
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      return { type: "not_accepting" };
    }

    if (result.type === "superseded_by_newer_ready") {
      logger.info("repo_image.build_superseded", {
        build_id: params.completion.buildId,
        provider,
        provider_image_id: result.supersededImage.image.providerImageId,
        provider_session_id: result.supersededImage.image.providerSessionId ?? null,
        duration_ms: Date.now() - params.startedAt,
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      const cleanup = this.deleteReplacedImages(
        params.adapter,
        [result.supersededImage],
        params.ctx
      );
      return cleanup ? { type: "superseded", cleanup } : { type: "superseded" };
    }

    logger.info("repo_image.build_complete", {
      build_id: params.completion.buildId,
      provider,
      provider_image_id: params.finalized.providerImageId,
      provider_session_id: params.completion.providerSessionId,
      base_sha: params.completion.baseSha,
      replaced_image_id: result.supersededImages[0]?.image.providerImageId ?? null,
      snapshot_duration_ms: Date.now() - params.startedAt,
      request_id: params.ctx.request_id,
      trace_id: params.ctx.trace_id,
    });

    const cleanup = this.deleteReplacedImages(params.adapter, result.supersededImages, params.ctx);
    return cleanup
      ? { type: "ready", replacedImages: result.supersededImages, cleanup }
      : { type: "ready", replacedImages: result.supersededImages };
  }

  private cleanupFailedBuild(
    provider: RepoImageProvider,
    failure: FailRepoImageBuild,
    ctx: RepoImageWorkflowContext
  ): Promise<void> | undefined {
    if (failure.kind !== "provider_session") return undefined;

    const adapter = this.createAdapterForBestEffortCleanup(provider, failure.buildId, ctx);
    if (!adapter?.cleanupFailedBuild) return undefined;

    return adapter
      .cleanupFailedBuild({
        ...failure,
        correlation: ctx,
      })
      .catch((e) => {
        logger.warn(`repo_image.${provider}_build_cleanup_failed`, {
          build_id: failure.buildId,
          provider_session_id: failure.providerSessionId,
          error: errorMessage(e),
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
      });
  }

  private async deleteImageBestEffort(
    image: FinalizeRepoImageBuildResult,
    ctx: RepoImageWorkflowContext,
    adapter: RepoImageBuildFinalizer
  ): Promise<boolean> {
    try {
      await adapter.deleteImage({
        image,
        correlation: ctx,
      });
      return true;
    } catch (e) {
      logger.warn("repo_image.delete_old_failed", {
        provider_image_id: image.providerImageId,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return false;
    }
  }

  private async cleanupCompletedBuild(
    provider: RepoImageProvider,
    adapter: RepoImageBuildFinalizer,
    input: CompleteProviderSessionBuild & { correlation: CorrelationContext },
    ctx: RepoImageWorkflowContext
  ): Promise<void> {
    if (!adapter.cleanupCompletedBuild) return;

    try {
      await adapter.cleanupCompletedBuild({
        kind: "provider_session",
        buildId: input.buildId,
        providerSessionId: input.providerSessionId,
        correlation: ctx,
      });
    } catch (e) {
      logger.warn(`repo_image.${provider}_completed_build_cleanup_failed`, {
        build_id: input.buildId,
        provider_session_id: input.providerSessionId,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }
  }
}

export function createRepoImageBuildWorkflowFromEnv(env: Env): RepoImageBuildWorkflow {
  return new RepoImageBuildWorkflow(
    env,
    new RepoImageStore(env.DB),
    createRepoImageBuildAdapterFactory(env),
    resolveRepoImageProvider(env.SANDBOX_PROVIDER)
  );
}

function createBuildId(owner: string, name: string, now: number): string {
  return `img-${owner}-${name}-${now}-${generateId(4)}`;
}

function callbackAuthRegistration(
  build: PlannedRepoImageBuild
): Partial<Pick<RepoImageBuild, "callbackTokenHash" | "callbackTokenExpiresAt">> {
  return build.callbackAuth.type === "bearer_token"
    ? {
        callbackTokenHash: build.callbackAuth.tokenHash,
        callbackTokenExpiresAt: build.callbackAuth.expiresAt,
      }
    : {};
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
