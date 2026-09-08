import { resolveBuildTimeoutSeconds } from "@open-inspect/shared";
import { createLogger, type CorrelationContext } from "../logger";
import { createSourceControlProviderFromEnv } from "../source-control";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import {
  generateImageBuildCallbackToken,
  hashImageBuildCallbackToken,
  IMAGE_BUILD_CALLBACK_TOKEN_TTL_MS,
} from "./callback-auth";
import type { ImageBuildProvider, ImageBuildScope } from "./model";
import { getImageBuildCloneAuthMode } from "./provider-policy";
import {
  loadScopeBuildSecrets,
  resolveScopeSandboxSettings,
  resolveScopeTarget,
  type ResolvedImageBuildTarget,
} from "./scope";
import type { ImageBuildCloneAuth, PlannedImageBuild } from "./types";

const logger = createLogger("image-builds:planner");
const MS_PER_SECOND = 1000;

/** The single-use callback token every build authenticates with (planner mints, workflow verifies). */
export interface PlannedCallbackAuth {
  token: string;
  tokenHash: string;
  expiresAt: number;
}

export type { ResolvedImageBuildTarget } from "./scope";

/**
 * Resolves a trigger request into a concrete provider build plan.
 *
 * The planner is the only image-build layer that loads secrets, and it leans
 * on scope.ts for everything kind-specific. Split deliberately: resolveTarget
 * and createCallbackAuth run BEFORE the build row is registered (cheap D1
 * read + pure crypto), while planBuild — which decrypts secrets — runs AFTER,
 * so a concurrent secret change always sees a row to supersede and the
 * build's now-stale secrets can never reach a still-selectable image.
 * Build-time secrets are the same set the scope's sessions get, and the build
 * timeout honors the primary repository's sandbox settings with the scope's
 * own overrides layered on top.
 */
export class ImageBuildPlanner {
  constructor(
    private readonly env: Env,
    private readonly db: SqlDatabase,
    private readonly provider: ImageBuildProvider
  ) {}

  async resolveTarget(scope: ImageBuildScope): Promise<ResolvedImageBuildTarget> {
    return resolveScopeTarget(this.env, this.db, scope);
  }

  async createCallbackAuth(): Promise<PlannedCallbackAuth> {
    const token = generateImageBuildCallbackToken();
    return {
      token,
      tokenHash: await hashImageBuildCallbackToken(token, this.env),
      expiresAt: Date.now() + IMAGE_BUILD_CALLBACK_TOKEN_TTL_MS,
    };
  }

  async planBuild(params: {
    buildId: string;
    scope: ImageBuildScope;
    callbackUrl: string;
    failureCallbackUrl: string;
    correlation: CorrelationContext;
    target: ResolvedImageBuildTarget;
    callbackAuth: PlannedCallbackAuth;
  }): Promise<PlannedImageBuild> {
    const { repositories, repositoriesFingerprint } = params.target;
    const primary = repositories[0];
    const callbackAuth = params.callbackAuth;

    const [sandboxSettings, userEnvVars, cloneAuth] = await Promise.all([
      resolveScopeSandboxSettings(this.db, params.scope, primary),
      loadScopeBuildSecrets(this.env, this.db, params.scope, params.target),
      this.resolveCloneAuth(params.scope),
    ]);

    const basePlan = {
      buildId: params.buildId,
      scope: params.scope,
      repositories,
      repositoriesFingerprint,
      callbackUrl: params.callbackUrl,
      failureCallbackUrl: params.failureCallbackUrl,
      buildTimeoutMs: resolveBuildTimeoutSeconds(sandboxSettings) * MS_PER_SECOND,
      userEnvVars,
      correlation: {
        trace_id: params.correlation.trace_id,
        request_id: params.correlation.request_id,
      },
    };

    const registration = { tokenHash: callbackAuth.tokenHash, expiresAt: callbackAuth.expiresAt };

    switch (this.provider) {
      case "modal":
        return {
          plan: {
            ...basePlan,
            provider: "modal",
            callbackMode: "provider_image",
            callbackToken: callbackAuth.token,
          },
          callbackAuth: registration,
        };
      case "vercel":
        return {
          plan: {
            ...basePlan,
            provider: "vercel",
            callbackMode: "provider_session",
            callbackToken: callbackAuth.token,
            cloneAuth,
          },
          callbackAuth: registration,
        };
      case "opencomputer":
        return {
          plan: {
            ...basePlan,
            provider: "opencomputer",
            callbackMode: "provider_session",
            callbackToken: callbackAuth.token,
            cloneAuth,
          },
          callbackAuth: registration,
        };
      default: {
        const exhaustive: never = this.provider;
        throw new Error(`Unsupported image build provider: ${String(exhaustive)}`);
      }
    }
  }

  private async resolveCloneAuth(scope: ImageBuildScope): Promise<ImageBuildCloneAuth> {
    if (getImageBuildCloneAuthMode(this.provider) !== "credential_helper") {
      return { type: "unavailable" };
    }

    try {
      const provider = createSourceControlProviderFromEnv(this.env);
      const auth = await provider.generateCredentialHelperAuth();
      return { type: "credential_helper", token: auth.password };
    } catch (e) {
      logger.warn("image_build.clone_token_failed", {
        error: e instanceof Error ? e.message : String(e),
        scope_kind: scope.kind,
        scope_id: scope.id,
      });
      return { type: "unavailable" };
    }
  }
}
