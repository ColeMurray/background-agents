import { ImageBuildStore } from "../db/image-builds";
import { createLogger, type CorrelationContext } from "../logger";
import { createSourceControlProviderFromEnv, type SourceControlProvider } from "../source-control";
import { errorMessage } from "./errors";
import { imageBuildFinalizationJob } from "./finalization-job";
import type { ImageBuildProvider } from "./model";
import { createImageBuildAdapterFactory, type ImageBuildAdapterFactory } from "./provider-factory";
import { DEFAULT_ARTIFACT_CLEANUP_MAX_AGE_MS, DEFAULT_STALE_BUILD_MAX_AGE_MS } from "./maintenance";
import { evaluateImageBuildRebuildPolicy } from "./rebuild-policy";
import { ImageBuildReaper } from "./reaper";
import { listEnabledScopes, resolveScopeTarget } from "./scope";
import { ImageBuildSessionCleanup } from "./session-cleanup";
import { createImageBuildWorkflowFromEnv, type ImageBuildWorkflow } from "./workflow";
import { resolveImageBuildProvider } from "./provider-policy";
import { runMaintenanceTasks } from "./concurrency";
import { repositoryIdentityKey } from "./provenance";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";

const logger = createLogger("image-builds:scheduler");

export const IMAGE_BUILD_SCHEDULER_CRON = "7,37 * * * *";

export interface ImageBuildSchedulerStats {
  finalizationsRepublished: number;
  staleMarked: number;
  cleanupAttempted: number;
  cleanupSucceeded: number;
  cleanupFailed: number;
  scopesScanned: number;
  branchLookups: number;
  branchMatched: number;
  branchDrifted: number;
  branchMissing: number;
  branchUnknown: number;
  triggered: number;
  triggerFailed: number;
  rowsAged: number;
  artifactsReaped: number;
}

export class ImageBuildScheduler {
  private readonly sessionCleanup: ImageBuildSessionCleanup;
  private readonly reaper: ImageBuildReaper;

  constructor(
    private readonly env: Env,
    private readonly db: SqlDatabase,
    private readonly provider: ImageBuildProvider | null,
    private readonly store: ImageBuildStore,
    private readonly workflow: ImageBuildWorkflow,
    adapterFactory: ImageBuildAdapterFactory,
    private readonly sourceControl: SourceControlProvider | null,
    private readonly resolveTarget: typeof resolveScopeTarget = resolveScopeTarget,
    private readonly listScopes: typeof listEnabledScopes = listEnabledScopes
  ) {
    this.sessionCleanup = new ImageBuildSessionCleanup(store, adapterFactory);
    this.reaper = new ImageBuildReaper(store, adapterFactory);
  }

  async run(correlation: CorrelationContext): Promise<ImageBuildSchedulerStats> {
    const startedAt = Date.now();
    const stats: ImageBuildSchedulerStats = {
      finalizationsRepublished: 0,
      staleMarked: 0,
      cleanupAttempted: 0,
      cleanupSucceeded: 0,
      cleanupFailed: 0,
      scopesScanned: 0,
      branchLookups: 0,
      branchMatched: 0,
      branchDrifted: 0,
      branchMissing: 0,
      branchUnknown: 0,
      triggered: 0,
      triggerFailed: 0,
      rowsAged: 0,
      artifactsReaped: 0,
    };

    try {
      stats.finalizationsRepublished = await this.republishRecoverableFinalizations();
    } catch (error) {
      logger.warn("image_build.scheduler_finalization_republish_failed", {
        error: errorMessage(error),
      });
    }

    try {
      stats.staleMarked = await this.store.markStaleBuildsAsFailed(DEFAULT_STALE_BUILD_MAX_AGE_MS);
    } catch (error) {
      logger.warn("image_build.scheduler_stale_failed", { error: errorMessage(error) });
    }

    try {
      await this.cleanupProviderSessions(stats, correlation);
    } catch (error) {
      logger.warn("image_build.scheduler_session_cleanup_phase_failed", {
        error: errorMessage(error),
      });
    }
    if (this.provider && this.sourceControl) {
      try {
        await this.reconcileScopes(stats, correlation);
      } catch (error) {
        logger.warn("image_build.scheduler_reconciliation_phase_failed", {
          error: errorMessage(error),
        });
      }
    }

    try {
      const cleanup = await this.reaper.cleanupImages(
        DEFAULT_ARTIFACT_CLEANUP_MAX_AGE_MS,
        correlation
      );
      stats.rowsAged = cleanup.deletedFailed;
      stats.artifactsReaped = cleanup.reapedFailed + cleanup.reapedSuperseded;
    } catch (error) {
      logger.warn("image_build.scheduler_artifact_cleanup_failed", {
        error: errorMessage(error),
      });
    }

    logger.info("image_build.scheduler_tick", {
      ...stats,
      provider: this.provider,
      cron: IMAGE_BUILD_SCHEDULER_CRON,
      duration_ms: Date.now() - startedAt,
      rebuild_enabled: this.provider !== null && this.sourceControl !== null,
      request_id: correlation.request_id,
      trace_id: correlation.trace_id,
    });
    return stats;
  }

  private async republishRecoverableFinalizations(): Promise<number> {
    const queue = this.env.IMAGE_BUILD_FINALIZATION_QUEUE;
    if (!queue) return 0;
    const rows = await this.store.listRecoverableFinalizations(Date.now());

    let published = 0;
    for (const row of rows) {
      try {
        await queue.send(imageBuildFinalizationJob(row.id, row.completion_hash));
        published += 1;
      } catch (error) {
        logger.warn("image_build.scheduler_finalization_republish_row_failed", {
          build_id: row.id,
          error: errorMessage(error),
        });
      }
    }
    return published;
  }

  private async cleanupProviderSessions(
    stats: ImageBuildSchedulerStats,
    correlation: CorrelationContext
  ): Promise<void> {
    const rows = await this.store.listSessionCleanup();

    await runMaintenanceTasks(rows, async (row) => {
      stats.cleanupAttempted += 1;
      try {
        await this.sessionCleanup.run(row, correlation);
        stats.cleanupSucceeded += 1;
      } catch (error) {
        stats.cleanupFailed += 1;
        logger.warn("image_build.scheduler_session_cleanup_failed", {
          build_id: row.id,
          provider: row.provider,
          provider_session_id: row.provider_session_id,
          error: errorMessage(error),
        });
      }
    });
  }

  private async reconcileScopes(
    stats: ImageBuildSchedulerStats,
    correlation: CorrelationContext
  ): Promise<void> {
    if (!this.provider || !this.sourceControl) return;
    const provider = this.provider;
    const sourceControl = this.sourceControl;
    const scopes = await this.listScopes(this.db);

    for (const scope of scopes) {
      try {
        const target = await this.resolveTarget(this.env, this.db, scope);
        const rows = await this.store.getReconciliationStatus(scope, provider);
        const decision = evaluateImageBuildRebuildPolicy(
          {
            scope,
            repositories: target.repositories,
            repositoriesFingerprint: target.repositoriesFingerprint,
          },
          rows,
          provider
        );

        let rebuild = decision.type === "rebuild";
        if (decision.type === "check_branches") {
          const heads: Array<string | null> = [];
          for (const repository of target.repositories) {
            stats.branchLookups += 1;
            try {
              const head = await sourceControl.getBranchHead({
                owner: repository.repoOwner,
                name: repository.repoName,
                branch: repository.baseBranch,
              });
              heads.push(head);
              if (head === null) {
                stats.branchMissing += 1;
              } else if (decision.recordedShas.get(repositoryIdentityKey(repository)) === head) {
                stats.branchMatched += 1;
              } else {
                stats.branchDrifted += 1;
              }
            } catch {
              heads.push(null);
              stats.branchUnknown += 1;
            }
          }
          rebuild = heads.some(
            (head, index) =>
              head !== null &&
              decision.recordedShas.get(repositoryIdentityKey(target.repositories[index])) !== head
          );
        }

        if (rebuild) {
          try {
            const result = await this.workflow.triggerBuildWithTarget(scope, target, correlation);
            if (result.type === "triggered") stats.triggered += 1;
          } catch {
            stats.triggerFailed += 1;
          }
        }
        stats.scopesScanned += 1;
      } catch (error) {
        stats.scopesScanned += 1;
        logger.warn("image_build.scheduler_scope_failed", {
          scope_kind: scope.kind,
          scope_id: scope.id,
          error: errorMessage(error),
        });
      }
    }
  }
}

export async function runImageBuildScheduler(
  env: Env,
  db: SqlDatabase,
  correlation: CorrelationContext
): Promise<ImageBuildSchedulerStats> {
  const provider = resolveImageBuildProvider(env.SANDBOX_PROVIDER);
  const store = new ImageBuildStore(db);
  let sourceControl: SourceControlProvider | null = null;
  if (provider) {
    try {
      sourceControl = createSourceControlProviderFromEnv(env);
    } catch (error) {
      logger.warn("image_build.scheduler_source_control_unavailable", {
        error: errorMessage(error),
      });
    }
  }
  return new ImageBuildScheduler(
    env,
    db,
    provider,
    store,
    createImageBuildWorkflowFromEnv(env, db),
    createImageBuildAdapterFactory(env),
    sourceControl
  ).run(correlation);
}
