import { generateId } from "../auth/crypto";
import { RepoImageStore } from "../db/repo-images";
import type { RepoImageBuild, RepoImageProvider } from "../db/repo-images";
import { createLogger, type CorrelationContext } from "../logger";
import type { Env } from "../types";
import { hashRepoImageCallbackToken } from "./auth";
import { getRepoImageBackend } from "./backend-policy";
import { RepoImageBuildPlanner } from "./planner";
import {
  createRepoImageBuildAdapterFactory,
  type RepoImageBuildAdapterFactory,
} from "./provider-factory";
import type {
  AnyRepoImageBuildAdapter,
  CompleteProviderSessionBuild,
  CompleteRepoImageBuild,
  FailRepoImageBuild,
  FinalizeRepoImageBuildResult,
  PlannedRepoImageBuild,
  RepoImageBuildFinalizer,
  RepoImageWorkflowContext,
  RepoImageWorkflowResult,
  ReplacedRepoImage,
} from "./types";

const logger = createLogger("repo-images:workflow");

type PlanBuildInput = Parameters<RepoImageBuildPlanner["planBuild"]>[0];
type AdapterResolution<TAdapter extends RepoImageBuildFinalizer> =
  | { type: "ok"; adapter: TAdapter }
  | {
      type: "unconfigured";
      result: Extract<RepoImageWorkflowResult, { type: "repo_image_provider_unconfigured" }>;
    };
type PlannedBuildStart =
  | {
      type: "ok";
      adapter: AnyRepoImageBuildAdapter;
      start(callbacks: {
        bindProviderSession(providerSessionId: string): Promise<void>;
      }): Promise<void>;
    }
  | Extract<AdapterResolution<AnyRepoImageBuildAdapter>, { type: "unconfigured" }>;

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
    private readonly adapterFactory: RepoImageBuildAdapterFactory,
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
    const buildId = createBuildId(owner, name, now);
    let providerSessionIdForCleanup: string | null = null;
    let adapterForCleanup: AnyRepoImageBuildAdapter | null = null;

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

      const build = planned.build;
      const start = this.preparePlannedBuildStart(build, ctx);
      if (start.type === "unconfigured") return start.result;
      adapterForCleanup = start.adapter;

      await this.store.registerBuild({
        id: buildId,
        repoOwner: owner,
        repoName: name,
        provider: this.backend,
        baseBranch: build.plan.baseBranch,
        ...callbackAuthRegistration(build),
      });

      await start.start({
        bindProviderSession: async (providerSessionId) => {
          providerSessionIdForCleanup = providerSessionId;
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
      if (providerSessionIdForCleanup && adapterForCleanup?.cleanupFailedBuild) {
        await adapterForCleanup
          .cleanupFailedBuild({
            kind: "provider_session",
            buildId,
            providerSessionId: providerSessionIdForCleanup,
            errorMessage: errorMessage(e),
            correlation: ctx,
          })
          .catch((cleanupError) => {
            logger.warn(`repo_image.${this.backend}_trigger_cleanup_failed`, {
              build_id: buildId,
              provider_session_id: providerSessionIdForCleanup,
              error: errorMessage(cleanupError),
              request_id: ctx.request_id,
              trace_id: ctx.trace_id,
            });
          });
      }

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

    let finalized: FinalizeRepoImageBuildResult | null = null;
    try {
      finalized = await adapter.finalizeSuccessfulBuild({
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
      if (finalized) {
        await this.deleteImageBestEffort(
          finalized.providerImageId,
          finalized.providerSessionId,
          ctx,
          adapter
        );
      }
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
  ): AdapterResolution<AnyRepoImageBuildAdapter> {
    switch (this.backend) {
      case "modal":
        return this.createAdapter(operation, ctx, () => this.adapterFactory.createModal(), buildId);
      case "vercel":
        return this.createAdapter(
          operation,
          ctx,
          () => this.adapterFactory.createVercel(),
          buildId
        );
      case "opencomputer":
        return this.createAdapter(
          operation,
          ctx,
          () => this.adapterFactory.createOpenComputer(),
          buildId
        );
    }
  }

  private createAdapter<TAdapter extends RepoImageBuildFinalizer>(
    operation: string,
    ctx: RepoImageWorkflowContext,
    create: () => TAdapter,
    buildId?: string
  ): AdapterResolution<TAdapter> {
    try {
      return { type: "ok", adapter: create() };
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

  private preparePlannedBuildStart(
    build: PlannedRepoImageBuild,
    ctx: RepoImageWorkflowContext
  ): PlannedBuildStart {
    const plan = build.plan;
    switch (plan.provider) {
      case "modal": {
        const adapterResolution = this.createAdapter(
          "trigger_build",
          ctx,
          () => this.adapterFactory.createModal(),
          plan.buildId
        );
        if (adapterResolution.type === "unconfigured") return adapterResolution;
        return {
          type: "ok",
          adapter: adapterResolution.adapter,
          start: (callbacks) => adapterResolution.adapter.startBuild(plan, callbacks),
        };
      }
      case "vercel": {
        const adapterResolution = this.createAdapter(
          "trigger_build",
          ctx,
          () => this.adapterFactory.createVercel(),
          plan.buildId
        );
        if (adapterResolution.type === "unconfigured") return adapterResolution;
        return {
          type: "ok",
          adapter: adapterResolution.adapter,
          start: (callbacks) => adapterResolution.adapter.startBuild(plan, callbacks),
        };
      }
      case "opencomputer": {
        const adapterResolution = this.createAdapter(
          "trigger_build",
          ctx,
          () => this.adapterFactory.createOpenComputer(),
          plan.buildId
        );
        if (adapterResolution.type === "unconfigured") return adapterResolution;
        return {
          type: "ok",
          adapter: adapterResolution.adapter,
          start: (callbacks) => adapterResolution.adapter.startBuild(plan, callbacks),
        };
      }
    }
  }

  private createAdapterForBestEffortCleanup(
    buildId: string,
    providerSessionId: string | null | undefined,
    ctx: RepoImageWorkflowContext
  ): AnyRepoImageBuildAdapter | null {
    const adapterResolution = this.createAdapterForOperation("cleanup", ctx, buildId);
    return adapterResolution.type === "ok" ? adapterResolution.adapter : null;
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
    let finalized: FinalizeRepoImageBuildResult | null = null;
    let adapter: AnyRepoImageBuildAdapter | null = null;

    try {
      const adapterResolution = this.createAdapterForOperation(
        "build_complete",
        ctx,
        input.buildId
      );
      if (adapterResolution.type === "unconfigured") {
        throw new Error(adapterResolution.result.message);
      }
      adapter = adapterResolution.adapter;
      logger.info(`repo_image.${this.backend}_finalize_start`, {
        build_id: input.buildId,
        provider_session_id: input.providerSessionId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      finalized = await adapter.finalizeSuccessfulBuild(input);

      const result = await this.markFinalizedBuildReady({
        adapter,
        completion: input,
        finalized,
        ctx,
        startedAt,
        deleteFinalizedImageOnReject: true,
      });
      await result.cleanup;
      await this.cleanupCompletedBuild(adapter, input, ctx);
    } catch (e) {
      const message = errorMessage(e);
      if (finalized && adapter) {
        await this.deleteImageBestEffort(
          finalized.providerImageId,
          finalized.providerSessionId,
          ctx,
          adapter
        );
      }
      if (adapter) {
        await this.cleanupCompletedBuild(adapter, input, ctx);
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
    adapter: RepoImageBuildFinalizer,
    replacedImages: ReplacedRepoImage[],
    ctx: RepoImageWorkflowContext
  ): Promise<void> | undefined {
    if (replacedImages.length === 0) return undefined;

    return Promise.all(
      replacedImages.map(async (image) => {
        const deleted = await this.deleteImageBestEffort(
          image.providerImageId,
          image.providerSessionId,
          ctx,
          adapter
        );
        if (deleted) {
          try {
            await this.store.deleteSupersededImage(image.repoImageId);
          } catch (e) {
            logger.warn("repo_image.delete_superseded_row_failed", {
              repo_image_id: image.repoImageId,
              provider_image_id: image.providerImageId,
              error: errorMessage(e),
              request_id: ctx.request_id,
              trace_id: ctx.trace_id,
            });
          }
        }
      })
    ).then(() => undefined);
  }

  private async markFinalizedBuildReady(params: {
    adapter: RepoImageBuildFinalizer;
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
      params.completion.buildDurationMs
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
    adapter: RepoImageBuildFinalizer
  ): Promise<boolean> {
    try {
      await adapter.deleteImage({
        providerImageId,
        providerSessionId,
        correlation: ctx,
      });
      return true;
    } catch (e) {
      logger.warn("repo_image.delete_old_failed", {
        provider_image_id: providerImageId,
        error: errorMessage(e),
      });
      return false;
    }
  }

  private async cleanupCompletedBuild(
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
      logger.warn(`repo_image.${this.backend}_completed_build_cleanup_failed`, {
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
    getRepoImageBackend(env)
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
