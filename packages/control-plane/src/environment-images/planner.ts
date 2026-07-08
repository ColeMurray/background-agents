import { resolveBuildTimeoutSeconds } from "@open-inspect/shared";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { EnvironmentStore } from "../db/environments";
import { GlobalSecretsStore } from "../db/global-secrets";
import {
  auditSecretsMerge,
  mergeSecretSources,
  parseSecretsCapMode,
} from "../db/secrets-validation";
import { createLogger, type CorrelationContext } from "../logger";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import type { Env } from "../types";
import {
  EnvironmentImageEnvironmentNotFoundError,
  EnvironmentImagePlanningError,
  EnvironmentImageProviderUnconfiguredError,
} from "./errors";
import { computeMembersFingerprint } from "./fingerprint";
import type { EnvironmentImageProvider } from "./model";
import type { EnvironmentImageBuildMember, PlannedEnvironmentImageBuild } from "./types";

const logger = createLogger("environment-images:planner");
const MS_PER_SECOND = 1000;

/**
 * Resolves a trigger request into a concrete provider build plan.
 *
 * The planner is the only environment-image layer that talks to the
 * environment and secrets stores. Build-time secrets are the same set the
 * environment's sessions get — global + environment, member repos never
 * inherit (design §6.4/§7.3 build/session parity) — and the build timeout
 * honors the primary member's sandbox settings.
 */
export class EnvironmentImageBuildPlanner {
  constructor(
    private readonly env: Env,
    private readonly provider: EnvironmentImageProvider
  ) {}

  async planBuild(params: {
    buildId: string;
    environmentId: string;
    callbackUrl: string;
    correlation: CorrelationContext;
  }): Promise<PlannedEnvironmentImageBuild> {
    const store = new EnvironmentStore(this.env.DB);
    const environment = await store.getById(params.environmentId);
    if (!environment) {
      throw new EnvironmentImageEnvironmentNotFoundError(params.environmentId);
    }

    const memberRows = await store.getRepositoriesForEnvironment(params.environmentId);
    if (memberRows.length === 0) {
      // Unreachable through the schema (environments require >= 1 repository);
      // defensive against direct store writes.
      throw new EnvironmentImagePlanningError(
        `Environment has no repositories: ${params.environmentId}`
      );
    }

    const repositories: EnvironmentImageBuildMember[] = memberRows.map((row) => ({
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      baseBranch: row.base_branch,
    }));
    const primary = repositories[0];

    const [membersFingerprint, sandboxSettings, userEnvVars] = await Promise.all([
      computeMembersFingerprint(repositories),
      resolveSandboxSettings(this.env.DB, primary.repoOwner, primary.repoName),
      this.loadUserEnvVars(params.environmentId),
    ]);

    const basePlan = {
      buildId: params.buildId,
      environmentId: params.environmentId,
      repositories,
      membersFingerprint,
      callbackUrl: params.callbackUrl,
      buildTimeoutMs: resolveBuildTimeoutSeconds(sandboxSettings) * MS_PER_SECOND,
      userEnvVars,
      correlation: {
        trace_id: params.correlation.trace_id,
        request_id: params.correlation.request_id,
      },
    };

    if (this.provider !== "modal") {
      throw new EnvironmentImageProviderUnconfiguredError(
        `Environment image builds are not supported for provider: ${this.provider}`
      );
    }

    return {
      plan: {
        ...basePlan,
        provider: "modal",
        callbackMode: "provider_image",
      },
      callbackAuth: { type: "none" },
    };
  }

  private async loadUserEnvVars(
    environmentId: string
  ): Promise<Record<string, string> | undefined> {
    if (!this.env.REPO_SECRETS_ENCRYPTION_KEY) return undefined;

    let globalSecrets: Record<string, string> = {};
    try {
      const globalStore = new GlobalSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      globalSecrets = await globalStore.getDecryptedSecrets();
    } catch (e) {
      logger.warn("environment_image.global_secrets_failed", {
        error: errorMessage(e),
        environment_id: environmentId,
      });
    }

    let environmentSecrets: Record<string, string> = {};
    try {
      const environmentStore = new EnvironmentSecretsStore(
        this.env.DB,
        this.env.REPO_SECRETS_ENCRYPTION_KEY
      );
      environmentSecrets = await environmentStore.getDecryptedSecrets(environmentId);
    } catch (e) {
      logger.warn("environment_image.environment_secrets_failed", {
        error: errorMessage(e),
        environment_id: environmentId,
      });
    }

    // Same source labels as the session spawn fold (launch-unit-secrets.ts) so
    // collision/cap logs attribute identically at build and session time.
    const merge = mergeSecretSources([
      { label: "global", secrets: globalSecrets },
      { label: "environment", secrets: environmentSecrets },
    ]);
    auditSecretsMerge({
      merge,
      mode: parseSecretsCapMode(this.env.SECRETS_CAP_ENFORCEMENT),
      log: logger,
      context: { environment_id: environmentId },
    });

    if (Object.keys(merge.merged).length === 0) return undefined;

    logger.info("environment_image.secrets_loaded", {
      global_count: Object.keys(globalSecrets).length,
      environment_count: Object.keys(environmentSecrets).length,
      merged_count: Object.keys(merge.merged).length,
      payload_bytes: merge.totalBytes,
      exceeds_limit: merge.exceedsLimit,
      environment_id: environmentId,
    });

    return merge.merged;
  }
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
