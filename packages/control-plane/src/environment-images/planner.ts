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
// Environment images share the repo-image callback-token scheme and per-provider
// policy wholesale (design §7.3 "Provider coverage") — one token scheme, one
// policy table, both renamed together in the build-subsystem unification.
import {
  generateRepoImageCallbackToken,
  hashRepoImageCallbackToken,
  REPO_IMAGE_CALLBACK_TOKEN_TTL_MS,
} from "../repo-images/auth";
import {
  getRepoImageCallbackMode,
  getRepoImageCloneAuthMode,
} from "../repo-images/provider-policy";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import { createSourceControlProviderFromEnv } from "../source-control";
import type { Env } from "../types";
import { EnvironmentImageEnvironmentNotFoundError, EnvironmentImagePlanningError } from "./errors";
import { computeRepositoriesFingerprint } from "./fingerprint";
import type { EnvironmentImageProvider } from "./model";
import type {
  EnvironmentImageBuildRepository,
  EnvironmentImageCloneAuth,
  PlannedEnvironmentImageBuild,
} from "./types";

const logger = createLogger("environment-images:planner");
const MS_PER_SECOND = 1000;

export type PlannedCallbackAuth =
  | { kind: "none" }
  | { kind: "bearer_token"; token: string; tokenHash: string; expiresAt: number };

/** Repositories + fingerprint, resolved before a build row exists. */
export interface ResolvedEnvironmentBuildTarget {
  repositories: EnvironmentImageBuildRepository[];
  repositoriesFingerprint: string;
}

/**
 * Resolves a trigger request into a concrete provider build plan.
 *
 * The planner is the only environment-image layer that talks to the
 * environment and secrets stores. Split deliberately: resolveTarget and
 * createCallbackAuth run BEFORE the build row is registered (cheap D1 read +
 * pure crypto), while planBuild — which decrypts secrets — runs AFTER, so a
 * concurrent secret change always sees a row to supersede and the build's
 * now-stale secrets can never reach a still-selectable image (§7.4).
 * Build-time secrets are the same set the environment's sessions get —
 * global + environment, repo-scoped secrets never inherit (§6.4 build/session
 * parity) — and the build timeout honors the primary repository's sandbox
 * settings with the environment's own overrides layered on top (§13.5).
 */
export class EnvironmentImageBuildPlanner {
  constructor(
    private readonly env: Env,
    private readonly provider: EnvironmentImageProvider
  ) {}

  async resolveTarget(environmentId: string): Promise<ResolvedEnvironmentBuildTarget> {
    const store = new EnvironmentStore(this.env.DB);
    const environment = await store.getById(environmentId);
    if (!environment) {
      throw new EnvironmentImageEnvironmentNotFoundError(environmentId);
    }

    const repositoryRows = await store.getRepositoriesForEnvironment(environmentId);
    if (repositoryRows.length === 0) {
      // Unreachable through the schema (environments require >= 1 repository);
      // defensive against direct store writes.
      throw new EnvironmentImagePlanningError(`Environment has no repositories: ${environmentId}`);
    }

    const repositories: EnvironmentImageBuildRepository[] = repositoryRows.map((row) => ({
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      baseBranch: row.base_branch,
    }));

    return {
      repositories,
      repositoriesFingerprint: await computeRepositoriesFingerprint(repositories),
    };
  }

  async createCallbackAuth(): Promise<PlannedCallbackAuth> {
    if (getRepoImageCallbackMode(this.provider) !== "provider_session") {
      return { kind: "none" };
    }

    const token = generateRepoImageCallbackToken();
    return {
      kind: "bearer_token",
      token,
      tokenHash: await hashRepoImageCallbackToken(token, this.env),
      expiresAt: Date.now() + REPO_IMAGE_CALLBACK_TOKEN_TTL_MS,
    };
  }

  async planBuild(params: {
    buildId: string;
    environmentId: string;
    callbackUrl: string;
    correlation: CorrelationContext;
    target: ResolvedEnvironmentBuildTarget;
    callbackAuth: PlannedCallbackAuth;
  }): Promise<PlannedEnvironmentImageBuild> {
    const { repositories, repositoriesFingerprint } = params.target;
    const primary = repositories[0];
    const callbackAuth = params.callbackAuth;

    const [sandboxSettings, userEnvVars, cloneAuth] = await Promise.all([
      resolveSandboxSettings(
        this.env.DB,
        primary.repoOwner,
        primary.repoName,
        params.environmentId
      ),
      this.loadUserEnvVars(params.environmentId),
      this.resolveCloneAuth(params.environmentId),
    ]);

    const basePlan = {
      buildId: params.buildId,
      environmentId: params.environmentId,
      repositories,
      repositoriesFingerprint,
      callbackUrl: params.callbackUrl,
      buildTimeoutMs: resolveBuildTimeoutSeconds(sandboxSettings) * MS_PER_SECOND,
      userEnvVars,
      correlation: {
        trace_id: params.correlation.trace_id,
        request_id: params.correlation.request_id,
      },
    };

    switch (this.provider) {
      case "modal":
        return {
          plan: { ...basePlan, provider: "modal", callbackMode: "provider_image" },
          callbackAuth: { type: "none" },
        };
      case "vercel": {
        const bearerAuth = requireBearerCallbackAuth(this.provider, callbackAuth);
        return {
          plan: {
            ...basePlan,
            provider: "vercel",
            callbackMode: "provider_session",
            callbackToken: bearerAuth.token,
            cloneAuth,
          },
          callbackAuth: {
            type: "bearer_token",
            tokenHash: bearerAuth.tokenHash,
            expiresAt: bearerAuth.expiresAt,
          },
        };
      }
      case "opencomputer": {
        const bearerAuth = requireBearerCallbackAuth(this.provider, callbackAuth);
        return {
          plan: {
            ...basePlan,
            provider: "opencomputer",
            callbackMode: "provider_session",
            callbackToken: bearerAuth.token,
            cloneAuth,
          },
          callbackAuth: {
            type: "bearer_token",
            tokenHash: bearerAuth.tokenHash,
            expiresAt: bearerAuth.expiresAt,
          },
        };
      }
      default: {
        const exhaustive: never = this.provider;
        throw new Error(`Unsupported environment image provider: ${String(exhaustive)}`);
      }
    }
  }

  private async resolveCloneAuth(environmentId: string): Promise<EnvironmentImageCloneAuth> {
    if (getRepoImageCloneAuthMode(this.provider) !== "credential_helper") {
      return { type: "unavailable" };
    }

    try {
      const provider = createSourceControlProviderFromEnv(this.env);
      const auth = await provider.generateCredentialHelperAuth();
      return { type: "credential_helper", token: auth.password };
    } catch (e) {
      logger.warn("environment_image.clone_token_failed", {
        error: errorMessage(e),
        environment_id: environmentId,
      });
      return { type: "unavailable" };
    }
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

    // Same source labels as the session spawn fold (session-target-secrets.ts) so
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

function requireBearerCallbackAuth(
  provider: EnvironmentImageProvider,
  callbackAuth: PlannedCallbackAuth
): Extract<PlannedCallbackAuth, { kind: "bearer_token" }> {
  if (callbackAuth.kind !== "bearer_token") {
    throw new Error(`${provider} environment image builds require callback token auth`);
  }
  return callbackAuth;
}
