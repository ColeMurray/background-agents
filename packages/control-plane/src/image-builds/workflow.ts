import { generateId } from "../auth/crypto";
import { ImageBuildStore, type ImageBuildRegistration } from "../db/image-builds";
import { createLogger } from "../logger";
import type { Env } from "../types";
import {
  consumeImageBuildCallbackTokenOrThrow,
  ImageBuildCallbackAuthError,
  markImageBuildFailedWithCallbackTokenOrThrow,
  requireInternalImageBuildCallbackAuth,
} from "./callback-auth";
import {
  ImageBuildCallbackAuthRejectedError,
  ImageBuildCallbackAuthUnavailableError,
  ImageBuildCompleteFailedError,
  ImageBuildCompletionNotAcceptedError,
  ImageBuildFailedUpdateError,
  ImageBuildFailureNotAcceptedError,
  ImageBuildInvalidCallbackError,
  ImageBuildPlanningError,
  ImageBuildProviderUnconfiguredError,
  ImageBuildScopeNotFoundError,
  ImageBuildTriggerFailedError,
  ImageBuildWorkflowUnavailableError,
} from "./errors";
import {
  parseRuntimeVersionNumber,
  type ImageBuildProvider,
  type ImageBuildProviderImageRef,
  type ImageBuildScope,
} from "./model";
import { ImageBuildPlanner, type PlannedCallbackAuth } from "./planner";
import { ImageBuildReaper } from "./reaper";
import { getImageBuildCallbackMode, resolveImageBuildProvider } from "./provider-policy";
import { createImageBuildAdapterFactory, type ImageBuildAdapterFactory } from "./provider-factory";
import type { RepositoryShaEntry } from "@open-inspect/shared";
import type {
  AnyImageBuildAdapter,
  CompleteImageBuildCallback,
  FailImageBuildCallback,
  ImageBuildStartCallbacks,
  ImageBuildWorkflowContext,
  ImageBuildWorkflowResult,
  PlannedImageBuild,
  TriggerImageBuildResult,
} from "./types";

const logger = createLogger("image-builds:workflow");

type ImageBuildPlannerLike = Pick<
  ImageBuildPlanner,
  "resolveTarget" | "createCallbackAuth" | "planBuild"
>;

export interface AcceptBuildCompleteCommand {
  completion: CompleteImageBuildCallback;
  authorizationHeader?: string | null;
  callbackToken?: string | null;
  context: ImageBuildWorkflowContext;
}

export interface AcceptBuildFailedCommand {
  failure: FailImageBuildCallback;
  authorizationHeader?: string | null;
  callbackToken?: string | null;
  context: ImageBuildWorkflowContext;
}

/** Fields common to both callback modes; provider_image adds the artifact id. */
interface ValidatedBuildCompletion {
  buildId: string;
  repositoryShas: RepositoryShaEntry[];
  runtimeVersion: string;
  buildDurationMs: number;
}

type PlannedBuildStart = {
  adapter: AnyImageBuildAdapter;
  start(callbacks: ImageBuildStartCallbacks): Promise<void>;
};

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
  private readonly planner: ImageBuildPlannerLike | null;
  private readonly reaper: ImageBuildReaper;

  constructor(
    private readonly env: Env,
    private readonly store: ImageBuildStore,
    private readonly adapterFactory: ImageBuildAdapterFactory,
    private readonly provider: ImageBuildProvider | null,
    planner?: ImageBuildPlannerLike
  ) {
    this.planner = planner ?? (provider ? new ImageBuildPlanner(env, provider) : null);
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
    return this.trigger(scope, ctx, { onlyIfStale: false });
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
    return this.trigger(scope, ctx, { onlyIfStale: true });
  }

  private async trigger(
    scope: ImageBuildScope,
    ctx: ImageBuildWorkflowContext,
    options: { onlyIfStale: boolean }
  ): Promise<TriggerImageBuildResult> {
    if (!this.provider || !this.planner) {
      throw new ImageBuildWorkflowUnavailableError("Image build provider is not configured");
    }
    if (!this.env.WORKER_URL) {
      throw new ImageBuildWorkflowUnavailableError("WORKER_URL not configured");
    }

    const provider = this.provider;
    const active = await this.store.getActiveBuild(scope, provider);
    if (active) {
      return { type: "already_building", buildId: active.id };
    }

    const buildId = createBuildId(scope);
    const callbackUrl = `${this.env.WORKER_URL}/image-builds/build-complete`;

    // Everything before registerBuild must stay cheap and secret-free: the
    // secret-change supersede can only see builds that have a row, so the
    // row is registered BEFORE secrets are decrypted (planBuild below).
    let target;
    let callbackAuth;
    try {
      target = await this.planner.resolveTarget(scope);

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

      // Probe the adapter now so a misconfigured provider fails 503 without
      // writing a failed row on every cron tick.
      this.createAdapterForOperation(provider, "trigger_build", ctx, buildId);
      callbackAuth = await this.planner.createCallbackAuth();
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
    let startAdapter: AnyImageBuildAdapter | null = null;
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

      const planned = await this.planner.planBuild({
        buildId,
        scope,
        callbackUrl,
        correlation: ctx,
        target,
        callbackAuth,
      });

      const start = this.preparePlannedBuildStart(planned, ctx);
      startAdapter = start.adapter;
      await start.start({
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
      if (providerSessionIdForCleanup && startAdapter?.cleanupFailedBuild) {
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

  /** Provider-typed start dispatch: each case keeps the plan/adapter pairing intact. */
  private preparePlannedBuildStart(
    planned: PlannedImageBuild,
    ctx: ImageBuildWorkflowContext
  ): PlannedBuildStart {
    const plan = planned.plan;
    switch (plan.provider) {
      case "modal": {
        const adapter = this.createAdapterGuarded(
          plan.provider,
          "trigger_build",
          ctx,
          () => this.adapterFactory.create("modal"),
          plan.buildId
        );
        return { adapter, start: (callbacks) => adapter.startBuild(plan, callbacks) };
      }
      case "vercel": {
        const adapter = this.createAdapterGuarded(
          plan.provider,
          "trigger_build",
          ctx,
          () => this.adapterFactory.create("vercel"),
          plan.buildId
        );
        return { adapter, start: (callbacks) => adapter.startBuild(plan, callbacks) };
      }
      case "opencomputer": {
        const adapter = this.createAdapterGuarded(
          plan.provider,
          "trigger_build",
          ctx,
          () => this.adapterFactory.create("opencomputer"),
          plan.buildId
        );
        return { adapter, start: (callbacks) => adapter.startBuild(plan, callbacks) };
      }
      default: {
        const exhaustive: never = plan;
        throw new ImageBuildProviderUnconfiguredError(
          `Unsupported image build provider: ${String(exhaustive)}`
        );
      }
    }
  }

  async acceptBuildComplete(
    command: AcceptBuildCompleteCommand
  ): Promise<ImageBuildWorkflowResult> {
    const { completion, context: ctx } = command;
    const build = await this.store.getCallbackBuild(completion.buildId);
    if (!build) {
      // The build may have been superseded out-of-band (entity delete,
      // secret change) while in flight — record its artifact for the reaper
      // before rejecting, or the provider-side snapshot leaks forever.
      await this.recordLateProviderImageArtifact(completion, command, ctx);
      throw new ImageBuildCompletionNotAcceptedError("Build is not accepting completion");
    }

    const provider = build.provider;

    if (getImageBuildCallbackMode(provider) === "provider_session") {
      const validated = this.validateCompletion(completion);
      // The sandbox itself reports completion with a bearer token; the
      // artifact does not exist yet — snapshotting is the deferred
      // finalization the route schedules via waitUntil.
      if (!completion.providerSessionId) {
        throw new ImageBuildInvalidCallbackError("provider_session_id is required");
      }
      const providerSessionId = completion.providerSessionId;

      await this.requireTokenBuildCallbackAuth(command.callbackToken, {
        buildId: build.id,
        provider,
        providerSessionId,
        ctx,
      });

      logger.info("image_build.build_complete_received", {
        build_id: validated.buildId,
        scope_kind: build.scope.kind,
        scope_id: build.scope.id,
        provider,
        provider_session_id: providerSessionId,
        runtime_version: validated.runtimeVersion,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      const finalization = this.finalizeAndCommit(
        provider,
        {
          ...validated,
          providerSessionId,
          scope: build.scope,
        },
        ctx
      );

      return { type: "completion_accepted", finalization };
    }

    // Internal-HMAC mode: authenticate before revealing anything about the
    // payload's validity.
    await this.requireInternalBuildCallbackAuth(command.authorizationHeader, build.id, ctx);
    const validated = this.validateCompletion(completion);
    if (!completion.providerImageId) {
      throw new ImageBuildInvalidCallbackError("provider_image_id is required");
    }
    const providerImageId = completion.providerImageId;

    let result;
    try {
      result = await this.store.tryMarkImageBuildReady(
        validated.buildId,
        provider,
        providerImageId,
        validated.repositoryShas,
        validated.runtimeVersion,
        validated.buildDurationMs
      );
    } catch (e) {
      logger.error("image_build.build_complete_error", {
        error: errorMessage(e),
        build_id: validated.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new ImageBuildCompleteFailedError("Failed to mark build as ready", e);
    }

    switch (result.type) {
      case "marked_ready": {
        logger.info("image_build.build_complete", {
          build_id: validated.buildId,
          scope_kind: build.scope.kind,
          scope_id: build.scope.id,
          provider,
          provider_image_id: providerImageId,
          runtime_version: validated.runtimeVersion,
          replaced_image_id: result.supersededImages[0]?.image.providerImageId ?? null,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        const cleanup = this.reaper.deleteReplacedImages(provider, result.supersededImages, ctx);
        return cleanup
          ? { type: "build_ready", replacedImages: result.supersededImages, cleanup }
          : { type: "build_ready", replacedImages: result.supersededImages };
      }
      case "superseded_by_newer_ready": {
        logger.info("image_build.build_superseded", {
          build_id: validated.buildId,
          scope_kind: build.scope.kind,
          scope_id: build.scope.id,
          provider,
          provider_image_id: result.supersededImage.image.providerImageId,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        const cleanup = this.reaper.deleteReplacedImages(provider, [result.supersededImage], ctx);
        return cleanup ? { type: "build_superseded", cleanup } : { type: "build_superseded" };
      }
      case "not_accepting_completion":
        // Superseded between getCallbackBuild and the transition — record the
        // artifact for the reaper (auth already passed above).
        await this.store.recordArtifactOnSupersededBuild(
          validated.buildId,
          provider,
          providerImageId
        );
        throw new ImageBuildCompletionNotAcceptedError("Build is not accepting completion");
    }
  }

  /**
   * A provider_image completion for a build whose row is no longer building:
   * the artifact already exists provider-side, so after authenticating,
   * record it on the (out-of-band superseded) row for the reaper. No-ops for
   * provider_session builds — their artifact is only created at finalization,
   * so nothing has leaked when the callback is rejected.
   */
  private async recordLateProviderImageArtifact(
    completion: CompleteImageBuildCallback,
    command: AcceptBuildCompleteCommand,
    ctx: ImageBuildWorkflowContext
  ): Promise<void> {
    if (!completion.providerImageId) return;

    const row = await this.store.getBuildRow(completion.buildId);
    if (!row || getImageBuildCallbackMode(row.provider) !== "provider_image") return;

    await this.requireInternalBuildCallbackAuth(command.authorizationHeader, row.id, ctx);

    const recorded = await this.store.recordArtifactOnSupersededBuild(
      row.id,
      row.provider,
      completion.providerImageId
    );
    if (recorded) {
      logger.info("image_build.late_artifact_recorded", {
        build_id: row.id,
        scope_kind: row.scope_kind,
        scope_id: row.scope_id,
        provider: row.provider,
        provider_image_id: completion.providerImageId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }
  }

  /**
   * Deferred finalization for provider-session builds: snapshot/checkpoint the
   * build sandbox, commit the artifact, reclaim what it replaced, tear the
   * sandbox down. Runs behind waitUntil — errors are logged and the build is
   * marked failed when no artifact was produced.
   */
  private async finalizeAndCommit(
    provider: ImageBuildProvider,
    input: ValidatedBuildCompletion & {
      providerSessionId: string;
      scope: ImageBuildScope;
    },
    ctx: ImageBuildWorkflowContext
  ): Promise<void> {
    const startedAt = Date.now();
    let finalized: ImageBuildProviderImageRef | null = null;
    let commitResolved = false;
    let adapter: AnyImageBuildAdapter | null = null;

    try {
      adapter = this.createAdapterForOperation(provider, "build_complete", ctx, input.buildId);
      if (!adapter.finalizeSuccessfulBuild) {
        throw new Error(`${provider} adapter cannot finalize provider-session builds`);
      }

      finalized = await adapter.finalizeSuccessfulBuild({
        buildId: input.buildId,
        providerSessionId: input.providerSessionId,
        correlation: ctx,
      });

      const result = await this.store.tryMarkImageBuildReady(
        input.buildId,
        provider,
        finalized.providerImageId,
        input.repositoryShas,
        input.runtimeVersion,
        input.buildDurationMs
      );
      // Any returned variant means the row transition is settled (ready,
      // superseded, or rejected-with-artifact-reclaimed) — from here the
      // catch below must not fail the build or touch the artifact.
      commitResolved = true;

      switch (result.type) {
        case "marked_ready": {
          logger.info("image_build.build_complete", {
            build_id: input.buildId,
            scope_kind: input.scope.kind,
            scope_id: input.scope.id,
            provider,
            provider_image_id: finalized.providerImageId,
            runtime_version: input.runtimeVersion,
            snapshot_duration_ms: Date.now() - startedAt,
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          });
          await this.reaper.deleteReplacedImages(provider, result.supersededImages, ctx);
          break;
        }
        case "superseded_by_newer_ready": {
          logger.info("image_build.build_superseded", {
            build_id: input.buildId,
            scope_kind: input.scope.kind,
            scope_id: input.scope.id,
            provider,
            provider_image_id: result.supersededImage.image.providerImageId,
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          });
          await this.reaper.deleteReplacedImages(provider, [result.supersededImage], ctx);
          break;
        }
        case "not_accepting_completion": {
          // A newer build won while we were snapshotting — the artifact just
          // produced would orphan, so reclaim it now.
          await this.reaper.deleteImageBestEffort(provider, finalized, ctx, adapter);
          logger.warn("image_build.finalize_not_applied", {
            build_id: input.buildId,
            provider,
            provider_image_id: finalized.providerImageId,
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          });
          break;
        }
      }

      await this.cleanupCompletedBuild(provider, adapter, input, ctx);
    } catch (e) {
      if (adapter) {
        await this.cleanupCompletedBuild(provider, adapter, input, ctx);
      }
      if (!commitResolved) {
        // The ready transition never settled: the row is still building and
        // a snapshot taken by finalizeSuccessfulBuild would orphan — nothing
        // records its id for the reaper — so reclaim it before failing the
        // build.
        if (finalized && adapter) {
          await this.reaper.deleteImageBestEffort(provider, finalized, ctx, adapter);
        }
        try {
          await this.store.markBuildFailed(input.buildId, provider, errorMessage(e));
        } catch (markFailedError) {
          logger.error("image_build.mark_failed_after_finalize_error", {
            build_id: input.buildId,
            error: errorMessage(markFailedError),
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          });
        }
      }
      logger.error("image_build.finalize_error", {
        build_id: input.buildId,
        provider,
        provider_session_id: input.providerSessionId,
        provider_image_id: finalized?.providerImageId,
        error: errorMessage(e),
        duration_ms: Date.now() - startedAt,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }
  }

  private async cleanupCompletedBuild(
    provider: ImageBuildProvider,
    adapter: AnyImageBuildAdapter,
    input: { buildId: string; providerSessionId: string },
    ctx: ImageBuildWorkflowContext
  ): Promise<void> {
    if (!adapter.cleanupCompletedBuild) return;
    try {
      await adapter.cleanupCompletedBuild({
        buildId: input.buildId,
        providerSessionId: input.providerSessionId,
        correlation: ctx,
      });
    } catch (e) {
      logger.warn(`image_build.${provider}_completed_build_cleanup_failed`, {
        build_id: input.buildId,
        provider_session_id: input.providerSessionId,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }
  }

  async acceptBuildFailed(command: AcceptBuildFailedCommand): Promise<ImageBuildWorkflowResult> {
    const { failure, context: ctx } = command;
    const build = await this.store.getCallbackBuild(failure.buildId);
    if (!build) {
      throw new ImageBuildFailureNotAcceptedError("Build is not accepting failure");
    }

    if (getImageBuildCallbackMode(build.provider) === "provider_session") {
      if (!failure.providerSessionId) {
        throw new ImageBuildInvalidCallbackError("provider_session_id is required");
      }
      const providerSessionId = failure.providerSessionId;

      await this.markProviderSessionBuildFailedWithCallbackToken(
        build.provider,
        { buildId: failure.buildId, providerSessionId, errorMessage: failure.errorMessage },
        command.callbackToken,
        ctx
      );

      logger.info("image_build.build_failed", {
        build_id: failure.buildId,
        scope_kind: build.scope.kind,
        scope_id: build.scope.id,
        provider: build.provider,
        error_message: failure.errorMessage,
        provider_session_id: providerSessionId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });

      const cleanup = this.cleanupFailedBuildBestEffort(
        build.provider,
        { buildId: failure.buildId, providerSessionId, errorMessage: failure.errorMessage },
        ctx
      );
      return cleanup ? { type: "build_failed", cleanup } : { type: "build_failed" };
    }

    await this.requireInternalBuildCallbackAuth(command.authorizationHeader, build.id, ctx);

    let updated: boolean;
    try {
      updated = await this.store.markBuildFailed(
        failure.buildId,
        build.provider,
        failure.errorMessage
      );
    } catch (e) {
      logger.error("image_build.build_failed_error", {
        error: errorMessage(e),
        build_id: failure.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new ImageBuildFailedUpdateError("Failed to mark build as failed", e);
    }

    if (!updated) {
      throw new ImageBuildFailureNotAcceptedError("Build is not accepting failure");
    }

    logger.info("image_build.build_failed", {
      build_id: failure.buildId,
      scope_kind: build.scope.kind,
      scope_id: build.scope.id,
      provider: build.provider,
      error_message: failure.errorMessage,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return { type: "build_failed" };
  }

  /** Cleanup pass over failed and superseded rows (reaper.ts). */
  async cleanupImages(
    failedMaxAgeMs: number,
    ctx: ImageBuildWorkflowContext
  ): Promise<{ deletedFailed: number; reapedSuperseded: number }> {
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

  private async requireTokenBuildCallbackAuth(
    token: string | null | undefined,
    params: {
      buildId: string;
      provider: ImageBuildProvider;
      providerSessionId: string;
      ctx: ImageBuildWorkflowContext;
    }
  ): Promise<void> {
    try {
      await consumeImageBuildCallbackTokenOrThrow(this.store, this.env, token, {
        buildId: params.buildId,
        provider: params.provider,
        providerSessionId: params.providerSessionId,
        now: Date.now(),
      });
    } catch (e) {
      throw this.loggedCallbackAuthError(e, params);
    }
  }

  private async markProviderSessionBuildFailedWithCallbackToken(
    provider: ImageBuildProvider,
    failure: { buildId: string; providerSessionId: string; errorMessage: string },
    callbackToken: string | null | undefined,
    ctx: ImageBuildWorkflowContext
  ): Promise<void> {
    try {
      await markImageBuildFailedWithCallbackTokenOrThrow(this.store, this.env, callbackToken, {
        buildId: failure.buildId,
        provider,
        providerSessionId: failure.providerSessionId,
        errorMessage: failure.errorMessage,
        now: Date.now(),
      });
    } catch (e) {
      if (!(e instanceof ImageBuildCallbackAuthError)) {
        logger.error("image_build.build_failed_error", {
          error: errorMessage(e),
          build_id: failure.buildId,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        throw new ImageBuildFailedUpdateError("Failed to mark build as failed", e);
      }
      throw this.loggedCallbackAuthError(e, {
        buildId: failure.buildId,
        provider,
        providerSessionId: failure.providerSessionId,
        ctx,
      });
    }
  }

  private async requireInternalBuildCallbackAuth(
    authorizationHeader: string | null | undefined,
    buildId: string,
    ctx: ImageBuildWorkflowContext
  ): Promise<void> {
    try {
      await requireInternalImageBuildCallbackAuth(this.env, authorizationHeader);
    } catch (e) {
      throw this.loggedCallbackAuthError(e, { buildId, ctx });
    }
  }

  /**
   * Log a callback-auth failure from the pure callback-auth helpers and map
   * it to the route-facing taxonomy. Non-auth errors rethrow unwrapped.
   */
  private loggedCallbackAuthError(
    e: unknown,
    params: {
      buildId: string;
      provider?: ImageBuildProvider;
      providerSessionId?: string;
      ctx: ImageBuildWorkflowContext;
    }
  ): Error {
    if (!(e instanceof ImageBuildCallbackAuthError)) {
      throw e;
    }

    if (e.failure === "misconfigured") {
      logger.error("image_build.callback_auth_misconfigured", {
        build_id: params.buildId,
        error: e.cause instanceof Error ? e.cause.message : undefined,
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

  private cleanupFailedBuildBestEffort(
    provider: ImageBuildProvider,
    failure: { buildId: string; providerSessionId: string; errorMessage: string },
    ctx: ImageBuildWorkflowContext
  ): Promise<void> | undefined {
    const adapter = this.reaper.createAdapterForBestEffortCleanup(provider, failure.buildId, ctx);
    if (!adapter?.cleanupFailedBuild) return undefined;

    return adapter
      .cleanupFailedBuild({
        ...failure,
        correlation: ctx,
      })
      .catch((e) => {
        logger.warn(`image_build.${provider}_build_cleanup_failed`, {
          build_id: failure.buildId,
          provider_session_id: failure.providerSessionId,
          error: errorMessage(e),
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
      });
  }

  private createAdapterForOperation(
    provider: ImageBuildProvider,
    operation: string,
    ctx: ImageBuildWorkflowContext,
    buildId?: string
  ): AnyImageBuildAdapter {
    return this.createAdapterGuarded(
      provider,
      operation,
      ctx,
      () => this.adapterFactory.create(provider),
      buildId
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

export function createImageBuildWorkflowFromEnv(env: Env): ImageBuildWorkflow {
  return new ImageBuildWorkflow(
    env,
    new ImageBuildStore(env.DB),
    createImageBuildAdapterFactory(env),
    resolveImageBuildProvider(env.SANDBOX_PROVIDER)
  );
}

/** One prefix for every scope kind; the scope id keeps ids greppable per entity. */
function createBuildId(scope: ImageBuildScope, now = Date.now()): string {
  return `imgb-${scope.id}-${now}-${generateId(4)}`;
}

function callbackAuthRegistration(
  callbackAuth: PlannedCallbackAuth
): Partial<Pick<ImageBuildRegistration, "callbackTokenHash" | "callbackTokenExpiresAt">> {
  return callbackAuth.kind === "bearer_token"
    ? {
        callbackTokenHash: callbackAuth.tokenHash,
        callbackTokenExpiresAt: callbackAuth.expiresAt,
      }
    : {};
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
