import { generateId } from "../auth/crypto";
import { ImageBuildStore, type ImageBuildRegistration } from "../db/image-builds";
import { createLogger } from "../logger";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import { hashImageBuildCallbackToken, ImageBuildCallbackAuthError } from "./callback-auth";
import {
  createImageBuildFinalizationJob,
  type ImageBuildFinalizationQueue,
} from "./finalization-job";
import {
  ImageBuildCallbackAuthRejectedError,
  ImageBuildCallbackAuthUnavailableError,
  ImageBuildCompletionNotAcceptedError,
  ImageBuildFailureNotAcceptedError,
  ImageBuildInvalidCallbackError,
  ImageBuildPlanningError,
  ImageBuildProviderUnconfiguredError,
  ImageBuildScopeNotFoundError,
  ImageBuildTriggerFailedError,
  ImageBuildWorkflowUnavailableError,
} from "./errors";
import { DEFAULT_STALE_BUILD_MAX_AGE_MS } from "./maintenance";
import { parseRuntimeVersionNumber, type ImageBuildProvider, type ImageBuildScope } from "./model";
import { ImageBuildPlanner, type PlannedCallbackAuth } from "./planner";
import { ImageBuildReaper } from "./reaper";
import { resolveImageBuildProvider } from "./provider-policy";
import { createImageBuildAdapterFactory, type ImageBuildAdapterFactory } from "./provider-factory";
import type { RepositoryShaEntry } from "@open-inspect/shared";
import type {
  ImageBuildAdapter,
  CompleteImageBuildCallback,
  FailImageBuildCallback,
  ImageBuildWorkflowContext,
  ImageBuildWorkflowResult,
  TriggerImageBuildResult,
} from "./types";

const logger = createLogger("image-builds:workflow");

type ImageBuildPlannerLike = Pick<
  ImageBuildPlanner,
  "resolveTarget" | "createCallbackAuth" | "planBuild"
>;

export interface AcceptBuildCompleteCommand {
  completion: CompleteImageBuildCallback;
  callbackToken?: string | null;
  context: ImageBuildWorkflowContext;
}

export interface AcceptBuildFailedCommand {
  failure: FailImageBuildCallback;
  callbackToken?: string | null;
  context: ImageBuildWorkflowContext;
}

/** Runtime-reported metadata persisted before Queue finalization. */
interface ValidatedBuildCompletion {
  buildId: string;
  repositoryShas: RepositoryShaEntry[];
  runtimeVersion: string;
  buildDurationMs: number;
}

/**
 * A configured image-build provider always travels with its planner — the
 * pair is either supplied together or the workflow is unconfigured. Encoding
 * the pairing here makes the invalid provider-without-planner state
 * unconstructible.
 */
export type ImageBuildProviderDeps = {
  provider: ImageBuildProvider;
  planner: ImageBuildPlannerLike;
} | null;

/**
 * Application service for the image-build lifecycle.
 *
 * Sequences planning, provider adapter calls, callback authorization, store
 * state transitions, and best-effort artifact cleanup. HTTP parsing stays in
 * routes, scope/secrets resolution in the planner (via scope.ts), and
 * provider API details in adapters.
 *
 * Public methods return successful domain outcomes and throw ImageBuildError
 * subclasses for route-level error mapping.
 */
export class ImageBuildWorkflow {
  private readonly reaper: ImageBuildReaper;

  constructor(
    private readonly env: Env,
    private readonly store: ImageBuildStore,
    private readonly adapterFactory: ImageBuildAdapterFactory,
    private readonly providerDeps: ImageBuildProviderDeps,
    private readonly finalizationQueue: ImageBuildFinalizationQueue | null = null
  ) {
    this.reaper = new ImageBuildReaper(store, adapterFactory);
  }

  /**
   * Trigger a build for a scope. All trigger sources — the cron pass,
   * save-hooks, and manual rebuilds — converge here, so the per-scope
   * concurrency-1 rule is enforced here rather than in any one caller.
   */
  async triggerBuild(
    scope: ImageBuildScope,
    ctx: ImageBuildWorkflowContext
  ): Promise<TriggerImageBuildResult> {
    // `await` (not bare promise adoption) so a synchronous rejection already
    // has its handler attached when the microtask queue drains — workerd
    // reports the one-job adoption gap as an unhandled rejection.
    return await this.trigger(scope, ctx, { onlyIfStale: false });
  }

  /**
   * Save-hook variant (saving the owning entity triggers an immediate build):
   * skips the build when a ready image already matches the current repository
   * set — that is the cron's trigger-1 check evaluated eagerly. Unconditional
   * rebuild reasons (sha drift, runtime floor) remain the cron's job.
   */
  async triggerBuildIfStale(
    scope: ImageBuildScope,
    ctx: ImageBuildWorkflowContext
  ): Promise<TriggerImageBuildResult> {
    // See triggerBuild for the `return await`.
    return await this.trigger(scope, ctx, { onlyIfStale: true });
  }

  /**
   * Lazy wedge recovery: a build whose sandbox died without a callback would
   * hold the concurrency-1 guard forever (getActiveBuild has no age cutoff).
   * Best-effort — a hygiene failure must never fail the trigger.
   */
  private async failStaleScopeBuild(
    scope: ImageBuildScope,
    provider: ImageBuildProvider,
    ctx: ImageBuildWorkflowContext
  ): Promise<void> {
    const logContext = {
      scope_kind: scope.kind,
      scope_id: scope.id,
      provider,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    };
    try {
      const staleFailed = await this.store.markScopeStaleBuildFailed(
        scope,
        provider,
        DEFAULT_STALE_BUILD_MAX_AGE_MS
      );
      if (staleFailed > 0) {
        logger.warn("image_build.stale_lazy_marked", { build_count: staleFailed, ...logContext });
      }
    } catch (e) {
      logger.warn("image_build.stale_lazy_mark_error", { error: errorMessage(e), ...logContext });
    }
  }

  private async trigger(
    scope: ImageBuildScope,
    ctx: ImageBuildWorkflowContext,
    options: { onlyIfStale: boolean }
  ): Promise<TriggerImageBuildResult> {
    if (!this.providerDeps) {
      throw new ImageBuildWorkflowUnavailableError("Image build provider is not configured");
    }
    if (!this.env.WORKER_URL) {
      throw new ImageBuildWorkflowUnavailableError("WORKER_URL not configured");
    }
    const { provider, planner } = this.providerDeps;

    // Validate provider configuration before any database work. This keeps a
    // bad deployment from accumulating failed rows and preserves the most
    // actionable configuration error when multiple bindings are absent.
    const adapter = this.createAdapterForOperation(provider, "trigger_build", ctx, "start");
    if (!this.finalizationQueue) {
      throw new ImageBuildWorkflowUnavailableError("Image build finalization Queue not configured");
    }

    await this.failStaleScopeBuild(scope, provider, ctx);

    const active = await this.store.getActiveBuild(scope, provider);
    if (active) {
      return { type: "already_building", buildId: active.id };
    }

    const buildId = createBuildId(scope);
    const callbackUrl = `${this.env.WORKER_URL}/image-builds/build-complete`;
    const failureCallbackUrl = `${this.env.WORKER_URL}/image-builds/build-failed`;

    // Everything before registerBuild must stay cheap and secret-free: the
    // secret-change supersede can only see builds that have a row, so the
    // row is registered BEFORE secrets are decrypted (planBuild below).
    let target;
    let callbackAuth;
    try {
      target = await planner.resolveTarget(scope);

      if (
        options.onlyIfStale &&
        (await this.store.hasReadyImageForFingerprint(
          scope,
          provider,
          target.repositoriesFingerprint
        ))
      ) {
        return { type: "up_to_date" };
      }

      callbackAuth = await planner.createCallbackAuth();
    } catch (e) {
      if (
        e instanceof ImageBuildScopeNotFoundError ||
        e instanceof ImageBuildPlanningError ||
        e instanceof ImageBuildProviderUnconfiguredError
      ) {
        throw e;
      }

      logger.error("image_build.trigger_error", {
        error: errorMessage(e),
        scope_kind: scope.kind,
        scope_id: scope.id,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new ImageBuildTriggerFailedError("Failed to trigger build", e);
    }

    let providerSessionIdForCleanup: string | null = null;
    let startAdapter: ImageBuildAdapter | null = null;
    try {
      const registered = await this.store.registerBuild({
        id: buildId,
        scope,
        provider,
        repositoriesFingerprint: target.repositoriesFingerprint,
        ...callbackAuthRegistration(callbackAuth),
      });
      if (!registered) {
        // A concurrent trigger won the registerBuild NOT EXISTS guard (the
        // getActiveBuild read above is only a cheap short-circuit, not
        // atomic with the insert). Report the winner's build.
        const winner = await this.store.getActiveBuild(scope, provider);
        if (!winner) {
          throw new Error("Concurrent trigger raced registerBuild and its build is already gone");
        }
        return { type: "already_building", buildId: winner.id };
      }

      const planned = await planner.planBuild({
        buildId,
        scope,
        callbackUrl,
        failureCallbackUrl,
        correlation: ctx,
        target,
        callbackAuth,
      });

      startAdapter = adapter;
      await adapter.startBuild(planned.plan, {
        bindProviderSession: async (providerSessionId) => {
          providerSessionIdForCleanup = providerSessionId;
          const bound = await this.store.bindProviderSession(buildId, provider, providerSessionId);
          if (!bound) {
            throw new Error(`Failed to bind ${provider} build session`);
          }
        },
      });

      logger.info("image_build.build_triggered", {
        build_id: buildId,
        scope_kind: scope.kind,
        scope_id: scope.id,
        repositories_fingerprint: planned.plan.repositoriesFingerprint,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      return { type: "triggered", buildId };
    } catch (e) {
      if (providerSessionIdForCleanup && startAdapter) {
        await startAdapter
          .cleanupFailedBuild({
            buildId,
            providerSessionId: providerSessionIdForCleanup,
            errorMessage: errorMessage(e),
            correlation: ctx,
          })
          .catch((cleanupError) => {
            logger.warn(`image_build.${provider}_trigger_cleanup_failed`, {
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
        logger.warn("image_build.trigger_mark_failed_error", {
          error: errorMessage(markFailedError),
          build_id: buildId,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
      }

      logger.error("image_build.trigger_error", {
        error: errorMessage(e),
        scope_kind: scope.kind,
        scope_id: scope.id,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new ImageBuildTriggerFailedError("Failed to trigger build", e);
    }
  }

  /**
   * Authenticates and durably accepts runtime success before publishing the
   * secret-free Queue command. Exact retries republish safely.
   */
  async acceptBuildComplete(
    command: AcceptBuildCompleteCommand
  ): Promise<ImageBuildWorkflowResult> {
    const { completion, context: ctx } = command;
    const providerSessionId = completion.providerSessionId ?? "";
    const authenticated = await this.authorizeCompletionCallback(
      completion.buildId,
      providerSessionId,
      command.callbackToken,
      ctx
    );
    const validated = this.validateCompletion(completion);
    if (!providerSessionId) {
      throw new ImageBuildInvalidCallbackError("provider_session_id is required");
    }
    const job = await createImageBuildFinalizationJob({
      outcome: "success",
      completion: { ...completion, ...validated, providerSessionId },
    });

    const acceptance = await this.store.finalization.acceptSuccessfulCompletion({
      buildId: authenticated.build.id,
      provider: authenticated.build.provider,
      providerSessionId,
      tokenHash: authenticated.tokenHash,
      completionHash: job.completionHash,
      repositoryShas: validated.repositoryShas,
      runtimeVersion: validated.runtimeVersion,
      buildDurationMs: validated.buildDurationMs,
      now: Date.now(),
    });
    if (acceptance === "rejected") {
      throw new ImageBuildCompletionNotAcceptedError("Build is not accepting completion");
    }
    if (authenticated.build.status === "building") {
      await this.requireFinalizationQueue().send(job);
    }

    logger.info("image_build.build_complete_received", {
      build_id: validated.buildId,
      scope_kind: authenticated.build.scope.kind,
      scope_id: authenticated.build.scope.id,
      provider: authenticated.build.provider,
      provider_session_id: providerSessionId,
      runtime_version: validated.runtimeVersion,
      replayed: acceptance === "replayed",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return { type: "completion_accepted" };
  }

  /**
   * Persists runtime failure and its cleanup obligation before publishing the
   * Queue command that tears down the bound provider session.
   */
  async acceptBuildFailed(command: AcceptBuildFailedCommand): Promise<ImageBuildWorkflowResult> {
    const { failure, context: ctx } = command;
    const providerSessionId = failure.providerSessionId ?? "";
    const authenticated = await this.authorizeCompletionCallback(
      failure.buildId,
      providerSessionId,
      command.callbackToken,
      ctx
    );
    if (!providerSessionId) {
      throw new ImageBuildInvalidCallbackError("provider_session_id is required");
    }
    const job = await createImageBuildFinalizationJob({
      outcome: "failure",
      failure: { ...failure, providerSessionId },
    });
    const acceptance = await this.store.finalization.acceptFailedCompletion({
      buildId: failure.buildId,
      provider: authenticated.build.provider,
      providerSessionId,
      tokenHash: authenticated.tokenHash,
      completionHash: job.completionHash,
      errorMessage: failure.errorMessage,
      now: Date.now(),
    });
    if (acceptance === "rejected") {
      throw new ImageBuildFailureNotAcceptedError("Build is not accepting failure");
    }
    await this.requireFinalizationQueue().send(job);

    logger.info("image_build.build_failed", {
      build_id: failure.buildId,
      scope_kind: authenticated.build.scope.kind,
      scope_id: authenticated.build.scope.id,
      provider: authenticated.build.provider,
      error_message: failure.errorMessage,
      provider_session_id: providerSessionId,
      replayed: acceptance === "replayed",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return { type: "failure_accepted" };
  }

  /** Cleanup pass over failed and superseded rows (reaper.ts). */
  async cleanupImages(
    failedMaxAgeMs: number,
    ctx: ImageBuildWorkflowContext
  ): Promise<{ deletedFailed: number; reapedFailed: number; reapedSuperseded: number }> {
    return this.reaper.cleanupImages(failedMaxAgeMs, ctx);
  }

  private validateCompletion(completion: CompleteImageBuildCallback): ValidatedBuildCompletion {
    if (!completion.repositoryShas || completion.repositoryShas.length === 0) {
      throw new ImageBuildInvalidCallbackError("repository_shas is required");
    }
    if (
      typeof completion.runtimeVersion !== "string" ||
      parseRuntimeVersionNumber(completion.runtimeVersion) === null
    ) {
      // Fail closed: an unversioned image must never be registered, or it
      // could pass spawn selection's floor check.
      throw new ImageBuildInvalidCallbackError(
        "runtime_version is required and must start with v<number>"
      );
    }
    if (
      typeof completion.buildDurationMs !== "number" ||
      !Number.isFinite(completion.buildDurationMs) ||
      completion.buildDurationMs < 0
    ) {
      throw new ImageBuildInvalidCallbackError(
        "build_duration_seconds must be a non-negative finite number"
      );
    }

    return {
      buildId: completion.buildId,
      repositoryShas: completion.repositoryShas,
      runtimeVersion: completion.runtimeVersion,
      buildDurationMs: completion.buildDurationMs,
    };
  }

  private async authorizeCompletionCallback(
    buildId: string,
    providerSessionId: string,
    token: string | null | undefined,
    ctx: ImageBuildWorkflowContext
  ) {
    if (!token) {
      throw this.loggedCallbackAuthError(
        new ImageBuildCallbackAuthError("rejected", "Unauthorized"),
        { buildId, providerSessionId, ctx }
      );
    }

    let tokenHash: string;
    try {
      tokenHash = await hashImageBuildCallbackToken(token, this.env);
    } catch (error) {
      throw this.loggedCallbackAuthError(
        new ImageBuildCallbackAuthError("misconfigured", "Callback auth unavailable", error),
        { buildId, providerSessionId, ctx }
      );
    }

    const authenticated = await this.store.finalization.authorizeCompletionCallback({
      buildId,
      providerSessionId,
      tokenHash,
      now: Date.now(),
    });
    if (!authenticated) {
      throw this.loggedCallbackAuthError(
        new ImageBuildCallbackAuthError("rejected", "Unauthorized"),
        { buildId, providerSessionId, ctx }
      );
    }
    return { ...authenticated, tokenHash };
  }

  private requireFinalizationQueue(): ImageBuildFinalizationQueue {
    if (!this.finalizationQueue) {
      throw new ImageBuildWorkflowUnavailableError("Image build finalization Queue not configured");
    }
    return this.finalizationQueue;
  }

  private loggedCallbackAuthError(
    error: ImageBuildCallbackAuthError,
    params: {
      buildId: string;
      provider?: ImageBuildProvider;
      providerSessionId?: string | null;
      ctx: ImageBuildWorkflowContext;
    }
  ): Error {
    if (error.failure === "misconfigured") {
      logger.error("image_build.callback_auth_misconfigured", {
        build_id: params.buildId,
        error: error.cause instanceof Error ? error.cause.message : undefined,
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      return new ImageBuildCallbackAuthUnavailableError("Internal authentication not configured");
    }

    logger.warn("image_build.callback_auth_failed", {
      build_id: params.buildId,
      provider: params.provider,
      provider_session_id: params.providerSessionId,
      request_id: params.ctx.request_id,
      trace_id: params.ctx.trace_id,
    });
    return new ImageBuildCallbackAuthRejectedError("Unauthorized");
  }

  private createAdapterForOperation(
    provider: ImageBuildProvider,
    operation: string,
    ctx: ImageBuildWorkflowContext,
    adapterOperation: "start" | "existing_session" = "existing_session"
  ): ImageBuildAdapter {
    return this.createAdapterGuarded(provider, operation, ctx, () =>
      this.adapterFactory.create(provider, adapterOperation)
    );
  }

  private createAdapterGuarded<TAdapter>(
    provider: ImageBuildProvider,
    operation: string,
    ctx: ImageBuildWorkflowContext,
    create: () => TAdapter,
    buildId?: string
  ): TAdapter {
    try {
      return create();
    } catch (e) {
      logger.error("image_build.adapter_config_error", {
        operation,
        build_id: buildId,
        provider,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new ImageBuildProviderUnconfiguredError("Image build provider is not configured", e);
    }
  }
}

export function createImageBuildWorkflowFromEnv(env: Env, db: SqlDatabase): ImageBuildWorkflow {
  const provider = resolveImageBuildProvider(env.SANDBOX_PROVIDER);
  const finalizationQueue = env.IMAGE_BUILD_FINALIZATION_QUEUE
    ? {
        async send(
          job: Parameters<NonNullable<Env["IMAGE_BUILD_FINALIZATION_QUEUE"]>["send"]>[0]
        ): Promise<void> {
          await env.IMAGE_BUILD_FINALIZATION_QUEUE!.send(job);
        },
      }
    : null;
  return new ImageBuildWorkflow(
    env,
    new ImageBuildStore(db),
    createImageBuildAdapterFactory(env),
    provider ? { provider, planner: new ImageBuildPlanner(env, db, provider) } : null,
    finalizationQueue
  );
}

/**
 * One prefix for every scope kind; the scope id keeps ids greppable per
 * entity. A repo scope id's `/` flattens to `-` so build ids stay safe as
 * path segments and provider labels.
 */
function createBuildId(scope: ImageBuildScope, now = Date.now()): string {
  return `imgb-${scope.id.replace("/", "-")}-${now}-${generateId(4)}`;
}

function callbackAuthRegistration(
  callbackAuth: PlannedCallbackAuth
): Pick<ImageBuildRegistration, "callbackTokenHash" | "callbackTokenExpiresAt"> {
  return {
    callbackTokenHash: callbackAuth.tokenHash,
    callbackTokenExpiresAt: callbackAuth.expiresAt,
  };
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
