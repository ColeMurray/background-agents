import { SourceControlProviderError } from "./errors";
import type { SourceControlProviderName } from "./types";
import { getGitHubAppConfig } from "../auth/github-app";
import type { Env } from "../types";
import type { SourceControlProviderFactoryConfig } from "./providers";

export const DEFAULT_SCM_PROVIDER: SourceControlProviderName = "github";

type ScmProviderResolutionEnv = Pick<
  Env,
  | "SCM_PROVIDER"
  | "GITHUB_APP_ID"
  | "GITHUB_APP_PRIVATE_KEY"
  | "GITHUB_APP_INSTALLATION_ID"
  | "BITBUCKET_WORKSPACE"
  | "BITBUCKET_CLIENT_ID"
  | "BITBUCKET_CLIENT_SECRET"
  | "BITBUCKET_BOT_USERNAME"
  | "BITBUCKET_BOT_APP_PASSWORD"
>;

type ScmProviderFactoryEnv = ScmProviderResolutionEnv &
  Pick<Env, "REPOS_CACHE">;

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function hasBitbucketProviderSignal(env: Pick<
  Env,
  | "BITBUCKET_WORKSPACE"
  | "BITBUCKET_CLIENT_ID"
  | "BITBUCKET_CLIENT_SECRET"
  | "BITBUCKET_BOT_USERNAME"
  | "BITBUCKET_BOT_APP_PASSWORD"
>): boolean {
  return (
    hasValue(env.BITBUCKET_WORKSPACE) ||
    hasValue(env.BITBUCKET_CLIENT_ID) ||
    hasValue(env.BITBUCKET_CLIENT_SECRET) ||
    hasValue(env.BITBUCKET_BOT_USERNAME) ||
    hasValue(env.BITBUCKET_BOT_APP_PASSWORD)
  );
}

export function resolveScmProviderFromEnv(value: string | undefined): SourceControlProviderName {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return DEFAULT_SCM_PROVIDER;
  }

  if (normalized === "github" || normalized === "bitbucket") {
    return normalized;
  }

  throw new SourceControlProviderError(
    `Invalid SCM_PROVIDER value '${normalized}'. Supported values: github, bitbucket.`,
    "permanent"
  );
}

export function resolveScmProvider(env: ScmProviderResolutionEnv): SourceControlProviderName {
  if (hasValue(env.SCM_PROVIDER)) {
    return resolveScmProviderFromEnv(env.SCM_PROVIDER);
  }

  const githubConfigured = Boolean(getGitHubAppConfig(env));
  const bitbucketConfigured = hasBitbucketProviderSignal(env);

  if (bitbucketConfigured && !githubConfigured) {
    return "bitbucket";
  }

  return DEFAULT_SCM_PROVIDER;
}

export function getSourceControlProviderFactoryConfig(
  env: ScmProviderFactoryEnv
): SourceControlProviderFactoryConfig {
  const provider = resolveScmProvider(env);
  const appConfig = getGitHubAppConfig(env);

  return {
    provider,
    github: {
      appConfig: appConfig ?? undefined,
      kvCache: env.REPOS_CACHE,
    },
    bitbucket: {
      workspace: env.BITBUCKET_WORKSPACE,
      clientId: env.BITBUCKET_CLIENT_ID,
      clientSecret: env.BITBUCKET_CLIENT_SECRET,
      botUsername: env.BITBUCKET_BOT_USERNAME,
      botAppPassword: env.BITBUCKET_BOT_APP_PASSWORD,
    },
  };
}
