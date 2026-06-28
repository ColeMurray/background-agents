import { resolveBuildTimeoutSeconds } from "@open-inspect/shared";
import { GlobalSecretsStore } from "../db/global-secrets";
import type { RepoImageProvider } from "../db/repo-images";
import { RepoSecretsStore } from "../db/repo-secrets";
import { mergeSecrets } from "../db/secrets-validation";
import { createLogger, type CorrelationContext } from "../logger";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import { createSourceControlProviderFromEnv, SourceControlProviderError } from "../source-control";
import type { Env } from "../types";
import {
  generateRepoImageCallbackToken,
  hashRepoImageCallbackToken,
  REPO_IMAGE_CALLBACK_TOKEN_TTL_MS,
} from "./auth";
import { getRepoImageCallbackMode } from "./backend-policy";
import type { RepoImageBuildPlan, VercelCloneAuth } from "./types";

const logger = createLogger("repo-images:planner");

type PlannedCallbackAuth =
  | { kind: "none" }
  | { kind: "bearer_token"; token: string; tokenHash: string; expiresAt: number };

export type RepoImageBuildPlanningResult =
  | {
      type: "ok";
      plan: RepoImageBuildPlan;
      registration: {
        baseBranch: string;
        callbackTokenHash?: string;
        callbackTokenExpiresAt?: number;
      };
    }
  | { type: "repo_not_installed"; message: string }
  | { type: "failed"; message: string };

export class RepoImageBuildPlanner {
  constructor(
    private readonly env: Env,
    private readonly backend: RepoImageProvider
  ) {}

  async planBuild(params: {
    buildId: string;
    repoOwner: string;
    repoName: string;
    now: number;
    callbackUrl: string;
    correlation: CorrelationContext;
  }): Promise<RepoImageBuildPlanningResult> {
    const resolved = await this.resolveRepo(params.repoOwner, params.repoName, params.correlation);
    if (resolved.type !== "ok") return resolved;

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
      buildTimeoutSeconds: resolveBuildTimeoutSeconds(sandboxSettings),
      userEnvVars,
      correlation: {
        trace_id: params.correlation.trace_id,
        request_id: params.correlation.request_id,
      },
    };
    const plan = this.createPlanForBackend(basePlan, callbackAuth, cloneAuth);

    return {
      type: "ok",
      plan,
      registration:
        callbackAuth.kind === "bearer_token"
          ? {
              baseBranch: resolved.defaultBranch,
              callbackTokenHash: callbackAuth.tokenHash,
              callbackTokenExpiresAt: callbackAuth.expiresAt,
            }
          : {
              baseBranch: resolved.defaultBranch,
            },
    };
  }

  private async resolveRepo(
    owner: string,
    name: string,
    correlation: CorrelationContext
  ): Promise<
    | { type: "ok"; repoId: number; defaultBranch: string }
    | { type: "repo_not_installed"; message: string }
    | { type: "failed"; message: string }
  > {
    try {
      const provider = createSourceControlProviderFromEnv(this.env);
      const resolved = await provider.checkRepositoryAccess({ owner, name });
      if (!resolved) {
        return {
          type: "repo_not_installed",
          message: "Repository is not installed for the GitHub App",
        };
      }
      return { type: "ok", repoId: resolved.repoId, defaultBranch: resolved.defaultBranch };
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
      return {
        type: "failed",
        message: isConfigError ? message : "Failed to resolve repository",
      };
    }
  }

  private async createCallbackAuth(now: number): Promise<PlannedCallbackAuth> {
    if (getRepoImageCallbackMode(this.backend) !== "provider_session") {
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

  private createPlanForBackend(
    basePlan: Omit<RepoImageBuildPlan, "provider" | "callbackMode" | "callbackToken" | "cloneAuth">,
    callbackAuth: PlannedCallbackAuth,
    cloneAuth: VercelCloneAuth
  ): RepoImageBuildPlan {
    if (this.backend === "modal") {
      return {
        ...basePlan,
        provider: "modal",
        callbackMode: "provider_image",
      };
    }

    if (callbackAuth.kind !== "bearer_token") {
      throw new Error(`${this.backend} repo image builds require callback token auth`);
    }

    if (this.backend === "vercel") {
      return {
        ...basePlan,
        provider: "vercel",
        callbackMode: "provider_session",
        callbackToken: callbackAuth.token,
        cloneAuth,
      };
    }

    return {
      ...basePlan,
      provider: "opencomputer",
      callbackMode: "provider_session",
      callbackToken: callbackAuth.token,
    };
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
    if (this.backend !== "vercel") return { type: "unavailable" };

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
