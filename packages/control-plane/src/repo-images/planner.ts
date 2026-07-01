import { resolveBuildTimeoutSeconds } from "@open-inspect/shared";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { mergeSecrets } from "../db/secrets-validation";
import { createLogger, type CorrelationContext } from "../logger";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import {
  createSourceControlProviderFromEnv,
  type RepositoryAccessResult,
  SourceControlProviderError,
} from "../source-control";
import type { Env } from "../types";
import {
  generateRepoImageCallbackToken,
  hashRepoImageCallbackToken,
  REPO_IMAGE_CALLBACK_TOKEN_TTL_MS,
} from "./auth";
import { RepoImagePlanningError, RepoImageRepositoryNotInstalledError } from "./errors";
import type { RepoImageProvider } from "./model";
import { getRepoImageCallbackMode } from "./provider-policy";
import type { PlannedRepoImageBuild, VercelCloneAuth } from "./types";

const logger = createLogger("repo-images:planner");
const MS_PER_SECOND = 1000;

type PlannedCallbackAuth =
  | { kind: "none" }
  | { kind: "bearer_token"; token: string; tokenHash: string; expiresAt: number };

interface BaseRepoImageBuildPlanInput {
  buildId: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  callbackUrl: string;
  buildTimeoutMs: number;
  userEnvVars?: Record<string, string>;
  correlation: CorrelationContext;
}

interface ResolvedRepoImageRepository {
  repoId: number;
  defaultBranch: string;
}

export class RepoImageBuildPlanner {
  constructor(
    private readonly env: Env,
    private readonly provider: RepoImageProvider
  ) {}

  async planBuild(params: {
    buildId: string;
    repoOwner: string;
    repoName: string;
    now: number;
    callbackUrl: string;
    correlation: CorrelationContext;
  }): Promise<PlannedRepoImageBuild> {
    const resolved = await this.resolveRepo(params.repoOwner, params.repoName, params.correlation);

    const [callbackAuth, sandboxSettings, userEnvVars, cloneAuth] = await Promise.all([
      this.createCallbackAuth(params.now),
      resolveSandboxSettings(this.env.DB, params.repoOwner, params.repoName),
      this.loadUserEnvVars({
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        repoId: resolved.repoId,
      }),
      this.resolveVercelCloneAuth({
        repoOwner: params.repoOwner,
        repoName: params.repoName,
      }),
    ]);

    const basePlan = {
      buildId: params.buildId,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      baseBranch: resolved.defaultBranch,
      callbackUrl: params.callbackUrl,
      buildTimeoutMs: resolveBuildTimeoutSeconds(sandboxSettings) * MS_PER_SECOND,
      userEnvVars,
      correlation: {
        trace_id: params.correlation.trace_id,
        request_id: params.correlation.request_id,
      },
    };

    return this.createPlannedBuildForProvider(basePlan, callbackAuth, cloneAuth);
  }

  private async resolveRepo(
    owner: string,
    name: string,
    correlation: CorrelationContext
  ): Promise<ResolvedRepoImageRepository> {
    let resolved: RepositoryAccessResult | null;
    try {
      const provider = createSourceControlProviderFromEnv(this.env);
      resolved = await provider.checkRepositoryAccess({ owner, name });
    } catch (e) {
      const message = errorMessage(e);
      logger.error("Failed to resolve repository", {
        error: message,
        repo_owner: owner,
        repo_name: name,
        request_id: correlation.request_id,
        trace_id: correlation.trace_id,
      });
      const isConfigError =
        e instanceof SourceControlProviderError && e.errorType === "permanent" && !e.httpStatus;
      throw new RepoImagePlanningError(isConfigError ? message : "Failed to resolve repository", e);
    }

    if (!resolved) {
      throw new RepoImageRepositoryNotInstalledError();
    }

    return { repoId: resolved.repoId, defaultBranch: resolved.defaultBranch };
  }

  private async createCallbackAuth(now: number): Promise<PlannedCallbackAuth> {
    if (getRepoImageCallbackMode(this.provider) !== "provider_session") {
      return { kind: "none" };
    }

    const token = generateRepoImageCallbackToken();
    return {
      kind: "bearer_token",
      token,
      tokenHash: await hashRepoImageCallbackToken(token, this.env),
      expiresAt: now + REPO_IMAGE_CALLBACK_TOKEN_TTL_MS,
    };
  }

  private createPlannedBuildForProvider(
    basePlan: BaseRepoImageBuildPlanInput,
    callbackAuth: PlannedCallbackAuth,
    cloneAuth: VercelCloneAuth
  ): PlannedRepoImageBuild {
    switch (this.provider) {
      case "modal":
        return {
          plan: {
            ...basePlan,
            provider: "modal",
            callbackMode: "provider_image",
          },
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
        throw new Error(`Unsupported repo image provider: ${String(exhaustive)}`);
      }
    }
  }

  private async loadUserEnvVars(params: {
    repoOwner: string;
    repoName: string;
    repoId: number;
  }): Promise<Record<string, string> | undefined> {
    if (!this.env.REPO_SECRETS_ENCRYPTION_KEY) return undefined;

    let globalSecrets: Record<string, string> = {};
    try {
      const globalStore = new GlobalSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      globalSecrets = await globalStore.getDecryptedSecrets();
    } catch (e) {
      logger.warn("repo_image.global_secrets_failed", {
        error: errorMessage(e),
        repo_owner: params.repoOwner,
        repo_name: params.repoName,
      });
    }

    let repoSecrets: Record<string, string> = {};
    try {
      const repoStore = new RepoSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      repoSecrets = await repoStore.getDecryptedSecrets(params.repoId);
    } catch (e) {
      logger.warn("repo_image.repo_secrets_failed", {
        error: errorMessage(e),
        repo_owner: params.repoOwner,
        repo_name: params.repoName,
      });
    }

    const { merged, totalBytes, exceedsLimit } = mergeSecrets(globalSecrets, repoSecrets);
    if (Object.keys(merged).length === 0) return undefined;

    const logLevel = exceedsLimit ? "warn" : "info";
    logger[logLevel]("repo_image.secrets_loaded", {
      global_count: Object.keys(globalSecrets).length,
      repo_count: Object.keys(repoSecrets).length,
      merged_count: Object.keys(merged).length,
      payload_bytes: totalBytes,
      exceeds_limit: exceedsLimit,
      repo_owner: params.repoOwner,
      repo_name: params.repoName,
    });

    return merged;
  }

  private async resolveVercelCloneAuth(params: {
    repoOwner: string;
    repoName: string;
  }): Promise<VercelCloneAuth> {
    if (this.provider !== "vercel") return { type: "unavailable" };

    try {
      const provider = createSourceControlProviderFromEnv(this.env);
      const auth = await provider.generateCredentialHelperAuth();
      return { type: "credential_helper", token: auth.password };
    } catch (e) {
      logger.warn("repo_image.clone_token_failed", {
        error: errorMessage(e),
        repo_owner: params.repoOwner,
        repo_name: params.repoName,
      });
      return { type: "unavailable" };
    }
  }
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function requireBearerCallbackAuth(
  provider: RepoImageProvider,
  callbackAuth: PlannedCallbackAuth
): Extract<PlannedCallbackAuth, { kind: "bearer_token" }> {
  if (callbackAuth.kind !== "bearer_token") {
    throw new Error(`${provider} repo image builds require callback token auth`);
  }
  return callbackAuth;
}
