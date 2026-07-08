import { generateId } from "../auth/crypto";
import { verifyInternalToken } from "../auth/internal";
import { EnvironmentImageStore } from "../db/environment-images";
import { createLogger } from "../logger";
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
  type SupersededEnvironmentImage,
} from "./model";
import { EnvironmentImageBuildPlanner } from "./planner";
import {
  createEnvironmentImageBuildAdapterFactory,
  type EnvironmentImageBuildAdapterFactory,
} from "./provider-factory";
import type {
  AnyEnvironmentImageBuildAdapter,
  CompleteEnvironmentImageBuildCallback,
  EnvironmentImageWorkflowContext,
  EnvironmentImageWorkflowResult,
  FailEnvironmentImageBuildCallback,
  TriggerEnvironmentImageBuildResult,
} from "./types";

const logger = createLogger("environment-images:workflow");

/** Superseded rows reclaimed per cleanup pass; leftovers wait for the next tick. */
const SUPERSEDED_REAP_BATCH_LIMIT = 25;

interface EnvironmentImageBuildPlannerLike {
  planBuild(
    params: Parameters<EnvironmentImageBuildPlanner["planBuild"]>[0]
  ): ReturnType<EnvironmentImageBuildPlanner["planBuild"]>;
}

export interface AcceptEnvironmentBuildCompleteCommand {
  completion: CompleteEnvironmentImageBuildCallback;
  authorizationHeader?: string | null;
  context: EnvironmentImageWorkflowContext;
}

export interface AcceptEnvironmentBuildFailedCommand {
  failure: FailEnvironmentImageBuildCallback;
  authorizationHeader?: string | null;
  context: EnvironmentImageWorkflowContext;
}

interface ValidatedEnvironmentBuildCompletion {
  buildId: string;
  providerImageId: string;
  memberShas: EnvironmentImageMemberSha[];
  runtimeVersion: string;
  buildDurationMs: number;
}

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

    let planned;
    try {
      planned = await this.planner.planBuild({
        buildId,
        environmentId,
        callbackUrl,
        correlation: ctx,
      });
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

    if (
      options.onlyIfStale &&
      (await this.store.hasReadyImageForFingerprint(
        environmentId,
        provider,
        planned.plan.membersFingerprint
      ))
    ) {
      return { type: "up_to_date" };
    }

    try {
      await this.store.registerBuild({
        id: buildId,
        environmentId,
        provider,
        membersFingerprint: planned.plan.membersFingerprint,
      });

      const adapter = this.createAdapterForOperation(provider, "trigger_build", ctx, buildId);
      await adapter.startBuild(planned.plan, {
        bindProviderSession: async () => {
          throw new Error("provider_session builds are not supported for environment images");
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

  async acceptBuildComplete(
    command: AcceptEnvironmentBuildCompleteCommand
  ): Promise<EnvironmentImageWorkflowResult> {
    const { completion, context: ctx } = command;
    const build = await this.store.getCallbackBuild(completion.buildId);
    if (!build) {
      throw new EnvironmentImageCompletionNotAcceptedError("Build is not accepting completion");
    }

    const provider = build.provider;
    if (getRepoImageCallbackMode(provider) !== "provider_image") {
      throw new EnvironmentImageInvalidCallbackError(
        "provider_session callbacks are not supported for environment images"
      );
    }

    await this.requireInternalBuildCallbackAuth(command.authorizationHeader, build.id, ctx);
    const validated = this.validateCompletion(completion);

    let result;
    try {
      result = await this.store.tryMarkEnvironmentImageReady(
        validated.buildId,
        provider,
        validated.providerImageId,
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
          provider_image_id: validated.providerImageId,
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
        throw new EnvironmentImageCompletionNotAcceptedError("Build is not accepting completion");
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
    await Promise.all(
      superseded.map(async (row) => {
        if (row.provider_image_id) {
          const adapter = this.createAdapterForBestEffortCleanup(row.provider, row.id, ctx);
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
    if (!completion.providerImageId) {
      throw new EnvironmentImageInvalidCallbackError("provider_image_id is required");
    }
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
      providerImageId: completion.providerImageId,
      memberShas: completion.memberShas,
      runtimeVersion: completion.runtimeVersion,
      buildDurationMs: completion.buildDurationMs,
    };
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
    try {
      return this.adapterFactory.create(provider);
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

    const adapter = this.createAdapterForBestEffortCleanup(provider, "", ctx);
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

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
