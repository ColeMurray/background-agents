import { generateId } from "../auth/crypto";
import { verifyInternalToken } from "../auth/internal";
import { EnvironmentImageStore, type EnvironmentImageBuild } from "../db/environment-images";
import { createLogger } from "../logger";
// Shared with repo images by design (§7.3): same token scheme, same provider policy.
import { hashRepoImageCallbackToken } from "../repo-images/auth";
import { getRepoImageCallbackMode, resolveRepoImageProvider } from "../repo-images/provider-policy";
import type { Env } from "../types";
import {
  EnvironmentImageBuildCompleteFailedError,
  EnvironmentImageBuildFailedUpdateError,
  EnvironmentImageCallbackAuthRejectedError,
  EnvironmentImageCallbackAuthUnavailableError,
  EnvironmentImageCompletionNotAcceptedError,
  EnvironmentImageEnvironmentNotFoundError,
  EnvironmentImageFailureNotAcceptedError,
  EnvironmentImageInvalidCallbackError,
  EnvironmentImagePlanningError,
  EnvironmentImageProviderUnconfiguredError,
  EnvironmentImageTriggerFailedError,
  EnvironmentImageWorkflowUnavailableError,
} from "./errors";
import {
  parseRuntimeVersionNumber,
  type EnvironmentImageMemberSha,
  type EnvironmentImageProvider,
  type EnvironmentImageProviderImageRef,
  type SupersededEnvironmentImage,
} from "./model";
import { EnvironmentImageBuildPlanner, type PlannedCallbackAuth } from "./planner";
import {
  createEnvironmentImageBuildAdapterFactory,
  type EnvironmentImageBuildAdapterFactory,
} from "./provider-factory";
import type {
  AnyEnvironmentImageBuildAdapter,
  CompleteEnvironmentImageBuildCallback,
  EnvironmentImageWorkflowContext,
  EnvironmentImageWorkflowResult,
  EnvironmentImageBuildStartCallbacks,
  FailEnvironmentImageBuildCallback,
  PlannedEnvironmentImageBuild,
  TriggerEnvironmentImageBuildResult,
} from "./types";

const logger = createLogger("environment-images:workflow");

/** Superseded rows reclaimed per cleanup pass; leftovers wait for the next tick. */
const SUPERSEDED_REAP_BATCH_LIMIT = 25;

type EnvironmentImageBuildPlannerLike = Pick<
  EnvironmentImageBuildPlanner,
  "resolveTarget" | "createCallbackAuth" | "planBuild"
>;

export interface AcceptEnvironmentBuildCompleteCommand {
  completion: CompleteEnvironmentImageBuildCallback;
  authorizationHeader?: string | null;
  callbackToken?: string | null;
  context: EnvironmentImageWorkflowContext;
}

export interface AcceptEnvironmentBuildFailedCommand {
  failure: FailEnvironmentImageBuildCallback;
  authorizationHeader?: string | null;
  callbackToken?: string | null;
  context: EnvironmentImageWorkflowContext;
}

/** Fields common to both callback modes; provider_image adds the artifact id. */
interface ValidatedEnvironmentBuildCompletion {
  buildId: string;
  memberShas: EnvironmentImageMemberSha[];
  runtimeVersion: string;
  buildDurationMs: number;
}

type PlannedBuildStart = {
  adapter: AnyEnvironmentImageBuildAdapter;
  start(callbacks: EnvironmentImageBuildStartCallbacks): Promise<void>;
};

/**
 * Application service for the environment image build lifecycle (design §7.3).
 *
 * Sequences planning, provider adapter calls, callback authorization, store
 * state transitions, and best-effort artifact cleanup — the environment twin
 * of RepoImageBuildWorkflow, trimmed to the provider_image callback mode
 * Modal uses. HTTP parsing stays in routes, environment/secrets resolution in
 * the planner, and provider API details in adapters.
 *
 * Public methods return successful domain outcomes and throw
 * EnvironmentImageError subclasses for route-level error mapping.
 */
export class EnvironmentImageBuildWorkflow {
  private readonly planner: EnvironmentImageBuildPlannerLike | null;

  constructor(
    private readonly env: Env,
    private readonly store: EnvironmentImageStore,
    private readonly adapterFactory: EnvironmentImageBuildAdapterFactory,
    private readonly provider: EnvironmentImageProvider | null,
    planner?: EnvironmentImageBuildPlannerLike
  ) {
    this.planner = planner ?? (provider ? new EnvironmentImageBuildPlanner(env, provider) : null);
  }

  /**
   * Trigger a build for an environment. All trigger sources — the cron pass,
   * save-hooks, and manual rebuilds — converge here, so the per-environment
   * concurrency-1 rule is enforced here rather than in any one caller.
   */
  async triggerBuild(
    environmentId: string,
    ctx: EnvironmentImageWorkflowContext
  ): Promise<TriggerEnvironmentImageBuildResult> {
    return this.trigger(environmentId, ctx, { onlyIfStale: false });
  }

  /**
   * Save-hook variant (design §7.3 "saving an environment triggers an
   * immediate build"): skips the build when a ready image already matches the
   * current member set — that is the cron's trigger-1 check evaluated
   * eagerly. Unconditional rebuild reasons (sha drift, runtime floor) remain
   * the cron's job.
   */
  async triggerBuildIfStale(
    environmentId: string,
    ctx: EnvironmentImageWorkflowContext
  ): Promise<TriggerEnvironmentImageBuildResult> {
    return this.trigger(environmentId, ctx, { onlyIfStale: true });
  }

  private async trigger(
    environmentId: string,
    ctx: EnvironmentImageWorkflowContext,
    options: { onlyIfStale: boolean }
  ): Promise<TriggerEnvironmentImageBuildResult> {
    if (!this.provider || !this.planner) {
      throw new EnvironmentImageWorkflowUnavailableError(
        "Environment image provider is not configured"
      );
    }
    if (!this.env.WORKER_URL) {
      throw new EnvironmentImageWorkflowUnavailableError("WORKER_URL not configured");
    }

    const provider = this.provider;
    const active = await this.store.getActiveBuild(environmentId, provider);
    if (active) {
      return { type: "already_building", buildId: active.id };
    }

    const buildId = createBuildId(environmentId);
    const callbackUrl = `${this.env.WORKER_URL}/environment-images/build-complete`;

    // Everything before registerBuild must stay cheap and secret-free: the
    // §7.4 secret-change supersede can only see builds that have a row, so
    // the row is registered BEFORE secrets are decrypted (planBuild below).
    let target;
    let callbackAuth;
    try {
      target = await this.planner.resolveTarget(environmentId);

      if (
        options.onlyIfStale &&
        (await this.store.hasReadyImageForFingerprint(
          environmentId,
          provider,
          target.membersFingerprint
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
        e instanceof EnvironmentImageEnvironmentNotFoundError ||
        e instanceof EnvironmentImagePlanningError ||
        e instanceof EnvironmentImageProviderUnconfiguredError
      ) {
        throw e;
      }

      logger.error("environment_image.trigger_error", {
        error: errorMessage(e),
        environment_id: environmentId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new EnvironmentImageTriggerFailedError("Failed to trigger build", e);
    }

    let providerSessionIdForCleanup: string | null = null;
    let startAdapter: AnyEnvironmentImageBuildAdapter | null = null;
    try {
      await this.store.registerBuild({
        id: buildId,
        environmentId,
        provider,
        membersFingerprint: target.membersFingerprint,
        ...callbackAuthRegistration(callbackAuth),
      });

      const planned = await this.planner.planBuild({
        buildId,
        environmentId,
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

      logger.info("environment_image.build_triggered", {
        build_id: buildId,
        environment_id: environmentId,
        members_fingerprint: planned.plan.membersFingerprint,
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
            logger.warn(`environment_image.${provider}_trigger_cleanup_failed`, {
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
        logger.warn("environment_image.trigger_mark_failed_error", {
          error: errorMessage(markFailedError),
          build_id: buildId,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
      }

      logger.error("environment_image.trigger_error", {
        error: errorMessage(e),
        environment_id: environmentId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new EnvironmentImageTriggerFailedError("Failed to trigger build", e);
    }
  }

  /** Provider-typed start dispatch: each case keeps the plan/adapter pairing intact. */
  private preparePlannedBuildStart(
    planned: PlannedEnvironmentImageBuild,
    ctx: EnvironmentImageWorkflowContext
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
        throw new EnvironmentImageProviderUnconfiguredError(
          `Unsupported environment image provider: ${String(exhaustive)}`
        );
      }
    }
  }

  async acceptBuildComplete(
    command: AcceptEnvironmentBuildCompleteCommand
  ): Promise<EnvironmentImageWorkflowResult> {
    const { completion, context: ctx } = command;
    const build = await this.store.getCallbackBuild(completion.buildId);
    if (!build) {
      // The build may have been superseded out-of-band (environment delete,
      // secret change) while in flight — record its artifact for the reaper
      // before rejecting, or the provider-side snapshot leaks forever.
      await this.recordLateProviderImageArtifact(completion, command, ctx);
      throw new EnvironmentImageCompletionNotAcceptedError("Build is not accepting completion");
    }

    const provider = build.provider;

    if (getRepoImageCallbackMode(provider) === "provider_session") {
      const validated = this.validateCompletion(completion);
      // The sandbox itself reports completion with a bearer token; the
      // artifact does not exist yet — snapshotting is the deferred
      // finalization the route schedules via waitUntil.
      if (!completion.providerSessionId) {
        throw new EnvironmentImageInvalidCallbackError("provider_session_id is required");
      }
      const providerSessionId = completion.providerSessionId;

      await this.requireTokenBuildCallbackAuth(command.callbackToken, {
        buildId: build.id,
        provider,
        providerSessionId,
        ctx,
      });

      logger.info("environment_image.build_complete_received", {
        build_id: validated.buildId,
        environment_id: build.environmentId,
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
          environmentId: build.environmentId,
        },
        ctx
      );

      return { type: "completion_accepted", finalization };
    }

    // Internal-HMAC mode: authenticate before revealing anything about the
    // payload's validity (parity with the repo-image workflow).
    await this.requireInternalBuildCallbackAuth(command.authorizationHeader, build.id, ctx);
    const validated = this.validateCompletion(completion);
    if (!completion.providerImageId) {
      throw new EnvironmentImageInvalidCallbackError("provider_image_id is required");
    }
    const providerImageId = completion.providerImageId;

    let result;
    try {
      result = await this.store.tryMarkEnvironmentImageReady(
        validated.buildId,
        provider,
        providerImageId,
        validated.memberShas,
        validated.runtimeVersion,
        validated.buildDurationMs
      );
    } catch (e) {
      logger.error("environment_image.build_complete_error", {
        error: errorMessage(e),
        build_id: validated.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new EnvironmentImageBuildCompleteFailedError("Failed to mark build as ready", e);
    }

    switch (result.type) {
      case "marked_ready": {
        logger.info("environment_image.build_complete", {
          build_id: validated.buildId,
          environment_id: build.environmentId,
          provider,
          provider_image_id: providerImageId,
          runtime_version: validated.runtimeVersion,
          replaced_image_id: result.supersededImages[0]?.image.providerImageId ?? null,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        const cleanup = this.deleteReplacedImages(provider, result.supersededImages, ctx);
        return cleanup
          ? { type: "build_ready", replacedImages: result.supersededImages, cleanup }
          : { type: "build_ready", replacedImages: result.supersededImages };
      }
      case "superseded_by_newer_ready": {
        logger.info("environment_image.build_superseded", {
          build_id: validated.buildId,
          environment_id: build.environmentId,
          provider,
          provider_image_id: result.supersededImage.image.providerImageId,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        const cleanup = this.deleteReplacedImages(provider, [result.supersededImage], ctx);
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
        throw new EnvironmentImageCompletionNotAcceptedError("Build is not accepting completion");
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
    completion: CompleteEnvironmentImageBuildCallback,
    command: AcceptEnvironmentBuildCompleteCommand,
    ctx: EnvironmentImageWorkflowContext
  ): Promise<void> {
    if (!completion.providerImageId) return;

    const row = await this.store.getBuildRow(completion.buildId);
    if (!row || getRepoImageCallbackMode(row.provider) !== "provider_image") return;

    await this.requireInternalBuildCallbackAuth(command.authorizationHeader, row.id, ctx);

    const recorded = await this.store.recordArtifactOnSupersededBuild(
      row.id,
      row.provider,
      completion.providerImageId
    );
    if (recorded) {
      logger.info("environment_image.late_artifact_recorded", {
        build_id: row.id,
        environment_id: row.environment_id,
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
    provider: EnvironmentImageProvider,
    input: ValidatedEnvironmentBuildCompletion & {
      providerSessionId: string;
      environmentId: string;
    },
    ctx: EnvironmentImageWorkflowContext
  ): Promise<void> {
    const startedAt = Date.now();
    let finalized: EnvironmentImageProviderImageRef | null = null;
    let adapter: AnyEnvironmentImageBuildAdapter | null = null;

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

      const result = await this.store.tryMarkEnvironmentImageReady(
        input.buildId,
        provider,
        finalized.providerImageId,
        input.memberShas,
        input.runtimeVersion,
        input.buildDurationMs
      );

      switch (result.type) {
        case "marked_ready": {
          logger.info("environment_image.build_complete", {
            build_id: input.buildId,
            environment_id: input.environmentId,
            provider,
            provider_image_id: finalized.providerImageId,
            runtime_version: input.runtimeVersion,
            snapshot_duration_ms: Date.now() - startedAt,
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          });
          await this.deleteReplacedImages(provider, result.supersededImages, ctx);
          break;
        }
        case "superseded_by_newer_ready": {
          logger.info("environment_image.build_superseded", {
            build_id: input.buildId,
            environment_id: input.environmentId,
            provider,
            provider_image_id: result.supersededImage.image.providerImageId,
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          });
          await this.deleteReplacedImages(provider, [result.supersededImage], ctx);
          break;
        }
        case "not_accepting_completion": {
          // A newer build won while we were snapshotting — the artifact just
          // produced would orphan, so reclaim it now.
          await this.deleteImageBestEffort(provider, finalized, ctx, adapter);
          logger.warn("environment_image.finalize_not_applied", {
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
      if (!finalized) {
        try {
          await this.store.markBuildFailed(input.buildId, provider, errorMessage(e));
        } catch (markFailedError) {
          logger.error("environment_image.mark_failed_after_finalize_error", {
            build_id: input.buildId,
            error: errorMessage(markFailedError),
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          });
        }
      }
      logger.error("environment_image.finalize_error", {
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
    provider: EnvironmentImageProvider,
    adapter: AnyEnvironmentImageBuildAdapter,
    input: { buildId: string; providerSessionId: string },
    ctx: EnvironmentImageWorkflowContext
  ): Promise<void> {
    if (!adapter.cleanupCompletedBuild) return;
    try {
      await adapter.cleanupCompletedBuild({
        buildId: input.buildId,
        providerSessionId: input.providerSessionId,
        correlation: ctx,
      });
    } catch (e) {
      logger.warn(`environment_image.${provider}_completed_build_cleanup_failed`, {
        build_id: input.buildId,
        provider_session_id: input.providerSessionId,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }
  }

  async acceptBuildFailed(
    command: AcceptEnvironmentBuildFailedCommand
  ): Promise<EnvironmentImageWorkflowResult> {
    const { failure, context: ctx } = command;
    const build = await this.store.getCallbackBuild(failure.buildId);
    if (!build) {
      throw new EnvironmentImageFailureNotAcceptedError("Build is not accepting failure");
    }

    if (getRepoImageCallbackMode(build.provider) === "provider_session") {
      if (!failure.providerSessionId) {
        throw new EnvironmentImageInvalidCallbackError("provider_session_id is required");
      }
      const providerSessionId = failure.providerSessionId;

      await this.markProviderSessionBuildFailedWithCallbackToken(
        build.provider,
        { buildId: failure.buildId, providerSessionId, errorMessage: failure.errorMessage },
        command.callbackToken,
        ctx
      );

      logger.info("environment_image.build_failed", {
        build_id: failure.buildId,
        environment_id: build.environmentId,
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
      logger.error("environment_image.build_failed_error", {
        error: errorMessage(e),
        build_id: failure.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new EnvironmentImageBuildFailedUpdateError("Failed to mark build as failed", e);
    }

    if (!updated) {
      throw new EnvironmentImageFailureNotAcceptedError("Build is not accepting failure");
    }

    logger.info("environment_image.build_failed", {
      build_id: failure.buildId,
      environment_id: build.environmentId,
      provider: build.provider,
      error_message: failure.errorMessage,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return { type: "build_failed" };
  }

  /**
   * Cleanup pass: delete old failed rows, then reap superseded rows — delete
   * the provider artifact (when one was recorded) and only then the row, so a
   * failed artifact delete is retried on the next pass. Covers both inline
   * supersedes whose deletion failed and out-of-band supersedes (environment
   * delete, secret change), which nothing deletes inline.
   */
  async cleanupImages(
    failedMaxAgeMs: number,
    ctx: EnvironmentImageWorkflowContext
  ): Promise<{ deletedFailed: number; reapedSuperseded: number }> {
    const deletedFailed = await this.store.deleteOldFailedBuilds(failedMaxAgeMs);

    const superseded = await this.store.getSupersededImages(SUPERSEDED_REAP_BATCH_LIMIT);
    let reapedSuperseded = 0;
    const adaptersByProvider = new Map<
      EnvironmentImageProvider,
      AnyEnvironmentImageBuildAdapter | null
    >();
    await Promise.all(
      superseded.map(async (row) => {
        if (row.provider_image_id) {
          if (!adaptersByProvider.has(row.provider)) {
            adaptersByProvider.set(
              row.provider,
              this.createAdapterForBestEffortCleanup(row.provider, row.id, ctx)
            );
          }
          const adapter = adaptersByProvider.get(row.provider) ?? null;
          if (!adapter) return;
          const deleted = await this.deleteImageBestEffort(
            row.provider,
            {
              providerImageId: row.provider_image_id,
              providerSessionId: row.provider_session_id,
            },
            ctx,
            adapter
          );
          if (!deleted) return;
        }
        if (await this.store.deleteSupersededImage(row.id)) {
          reapedSuperseded += 1;
        }
      })
    );

    return { deletedFailed, reapedSuperseded };
  }

  private validateCompletion(
    completion: CompleteEnvironmentImageBuildCallback
  ): ValidatedEnvironmentBuildCompletion {
    if (!completion.memberShas || completion.memberShas.length === 0) {
      throw new EnvironmentImageInvalidCallbackError("member_shas is required");
    }
    if (
      typeof completion.runtimeVersion !== "string" ||
      parseRuntimeVersionNumber(completion.runtimeVersion) === null
    ) {
      // Fail closed (design §7.3): an unversioned image must never be
      // registered, or it could pass spawn selection's floor check.
      throw new EnvironmentImageInvalidCallbackError(
        "runtime_version is required and must start with v<number>"
      );
    }
    if (
      typeof completion.buildDurationMs !== "number" ||
      !Number.isFinite(completion.buildDurationMs) ||
      completion.buildDurationMs < 0
    ) {
      throw new EnvironmentImageInvalidCallbackError(
        "build_duration_seconds must be a non-negative finite number"
      );
    }

    return {
      buildId: completion.buildId,
      memberShas: completion.memberShas,
      runtimeVersion: completion.runtimeVersion,
      buildDurationMs: completion.buildDurationMs,
    };
  }

  private async requireTokenBuildCallbackAuth(
    token: string | null | undefined,
    params: {
      buildId: string;
      provider: EnvironmentImageProvider;
      providerSessionId: string;
      ctx: EnvironmentImageWorkflowContext;
    }
  ): Promise<void> {
    const tokenHash = await this.hashRequiredCallbackToken(token, params);

    const build = await this.store.consumeCallbackToken({
      buildId: params.buildId,
      provider: params.provider,
      providerSessionId: params.providerSessionId,
      tokenHash,
      now: Date.now(),
    });

    if (!build) {
      this.logCallbackAuthFailed(params);
      throw new EnvironmentImageCallbackAuthRejectedError("Unauthorized");
    }
  }

  private async markProviderSessionBuildFailedWithCallbackToken(
    provider: EnvironmentImageProvider,
    failure: { buildId: string; providerSessionId: string; errorMessage: string },
    callbackToken: string | null | undefined,
    ctx: EnvironmentImageWorkflowContext
  ): Promise<void> {
    const tokenHash = await this.hashRequiredCallbackToken(callbackToken, {
      buildId: failure.buildId,
      provider,
      providerSessionId: failure.providerSessionId,
      ctx,
    });

    let updated: boolean;
    try {
      updated = await this.store.markBuildFailedWithCallbackToken({
        buildId: failure.buildId,
        provider,
        providerSessionId: failure.providerSessionId,
        tokenHash,
        error: failure.errorMessage,
        now: Date.now(),
      });
    } catch (e) {
      logger.error("environment_image.build_failed_error", {
        error: errorMessage(e),
        build_id: failure.buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new EnvironmentImageBuildFailedUpdateError("Failed to mark build as failed", e);
    }

    if (updated) return;

    this.logCallbackAuthFailed({
      buildId: failure.buildId,
      provider,
      providerSessionId: failure.providerSessionId,
      ctx,
    });
    throw new EnvironmentImageCallbackAuthRejectedError("Unauthorized");
  }

  private async hashRequiredCallbackToken(
    token: string | null | undefined,
    params: {
      buildId: string;
      provider: EnvironmentImageProvider;
      providerSessionId: string;
      ctx: EnvironmentImageWorkflowContext;
    }
  ): Promise<string> {
    if (!token) {
      this.logCallbackAuthFailed(params);
      throw new EnvironmentImageCallbackAuthRejectedError("Unauthorized");
    }

    try {
      return await hashRepoImageCallbackToken(token, this.env);
    } catch (e) {
      logger.error("environment_image.callback_auth_misconfigured", {
        build_id: params.buildId,
        error: errorMessage(e),
        request_id: params.ctx.request_id,
        trace_id: params.ctx.trace_id,
      });
      throw new EnvironmentImageCallbackAuthUnavailableError(
        "Internal authentication not configured"
      );
    }
  }

  private logCallbackAuthFailed(params: {
    buildId: string;
    provider: EnvironmentImageProvider;
    providerSessionId: string;
    ctx: EnvironmentImageWorkflowContext;
  }): void {
    logger.warn("environment_image.callback_auth_failed", {
      build_id: params.buildId,
      provider: params.provider,
      provider_session_id: params.providerSessionId,
      request_id: params.ctx.request_id,
      trace_id: params.ctx.trace_id,
    });
  }

  private cleanupFailedBuildBestEffort(
    provider: EnvironmentImageProvider,
    failure: { buildId: string; providerSessionId: string; errorMessage: string },
    ctx: EnvironmentImageWorkflowContext
  ): Promise<void> | undefined {
    const adapter = this.createAdapterForBestEffortCleanup(provider, failure.buildId, ctx);
    if (!adapter?.cleanupFailedBuild) return undefined;

    return adapter
      .cleanupFailedBuild({
        ...failure,
        correlation: ctx,
      })
      .catch((e) => {
        logger.warn(`environment_image.${provider}_build_cleanup_failed`, {
          build_id: failure.buildId,
          provider_session_id: failure.providerSessionId,
          error: errorMessage(e),
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
      });
  }

  private async requireInternalBuildCallbackAuth(
    authorizationHeader: string | null | undefined,
    buildId: string,
    ctx: EnvironmentImageWorkflowContext
  ): Promise<void> {
    if (!this.env.INTERNAL_CALLBACK_SECRET) {
      logger.error("environment_image.callback_auth_misconfigured", {
        build_id: buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new EnvironmentImageCallbackAuthUnavailableError(
        "Internal authentication not configured"
      );
    }

    const authorized = await verifyInternalToken(
      authorizationHeader ?? null,
      this.env.INTERNAL_CALLBACK_SECRET
    );
    if (authorized) return;

    logger.warn("environment_image.callback_auth_failed", {
      build_id: buildId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    throw new EnvironmentImageCallbackAuthRejectedError("Unauthorized");
  }

  private createAdapterForOperation(
    provider: EnvironmentImageProvider,
    operation: string,
    ctx: EnvironmentImageWorkflowContext,
    buildId?: string
  ): AnyEnvironmentImageBuildAdapter {
    return this.createAdapterGuarded(
      provider,
      operation,
      ctx,
      () => this.adapterFactory.create(provider),
      buildId
    );
  }

  private createAdapterGuarded<TAdapter>(
    provider: EnvironmentImageProvider,
    operation: string,
    ctx: EnvironmentImageWorkflowContext,
    create: () => TAdapter,
    buildId?: string
  ): TAdapter {
    try {
      return create();
    } catch (e) {
      logger.error("environment_image.adapter_config_error", {
        operation,
        build_id: buildId,
        provider,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      throw new EnvironmentImageProviderUnconfiguredError(
        "Environment image provider is not configured",
        e
      );
    }
  }

  private createAdapterForBestEffortCleanup(
    provider: EnvironmentImageProvider,
    buildId: string,
    ctx: EnvironmentImageWorkflowContext
  ): AnyEnvironmentImageBuildAdapter | null {
    try {
      return this.createAdapterForOperation(provider, "cleanup", ctx, buildId);
    } catch (e) {
      if (e instanceof EnvironmentImageProviderUnconfiguredError) return null;
      throw e;
    }
  }

  private deleteReplacedImages(
    provider: EnvironmentImageProvider,
    replacedImages: SupersededEnvironmentImage[],
    ctx: EnvironmentImageWorkflowContext
  ): Promise<void> | undefined {
    if (replacedImages.length === 0) return undefined;

    const adapter = this.createAdapterForBestEffortCleanup(
      provider,
      replacedImages[0].environmentImageId,
      ctx
    );
    if (!adapter) return undefined;

    return Promise.all(
      replacedImages.map(async (replacedImage) => {
        // Rows superseded before an artifact was recorded have nothing to
        // delete provider-side; the reaper removes the row.
        if (!replacedImage.image.providerImageId) return;
        const deleted = await this.deleteImageBestEffort(
          provider,
          replacedImage.image,
          ctx,
          adapter
        );
        if (deleted) {
          try {
            await this.store.deleteSupersededImage(replacedImage.environmentImageId);
          } catch (e) {
            logger.warn("environment_image.delete_superseded_row_failed", {
              environment_image_id: replacedImage.environmentImageId,
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

  private async deleteImageBestEffort(
    provider: EnvironmentImageProvider,
    image: { providerImageId: string; providerSessionId?: string | null },
    ctx: EnvironmentImageWorkflowContext,
    adapter: AnyEnvironmentImageBuildAdapter
  ): Promise<boolean> {
    try {
      await adapter.deleteImage({
        image,
        correlation: ctx,
      });
      return true;
    } catch (e) {
      logger.warn("environment_image.delete_old_failed", {
        provider,
        provider_image_id: image.providerImageId,
        error: errorMessage(e),
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return false;
    }
  }
}

export function createEnvironmentImageBuildWorkflowFromEnv(
  env: Env
): EnvironmentImageBuildWorkflow {
  return new EnvironmentImageBuildWorkflow(
    env,
    new EnvironmentImageStore(env.DB),
    createEnvironmentImageBuildAdapterFactory(env),
    resolveRepoImageProvider(env.SANDBOX_PROVIDER)
  );
}

function createBuildId(environmentId: string, now = Date.now()): string {
  return `envimg-${environmentId}-${now}-${generateId(4)}`;
}

function callbackAuthRegistration(
  callbackAuth: PlannedCallbackAuth
): Partial<Pick<EnvironmentImageBuild, "callbackTokenHash" | "callbackTokenExpiresAt">> {
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
