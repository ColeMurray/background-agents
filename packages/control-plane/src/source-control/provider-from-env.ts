import { resolveAppName } from "@open-inspect/shared/app-name";
import { getGitHubAppConfig } from "../auth/github-app";
import type { Env } from "../types";
import { reposCacheIdentity } from "../repos/cache";
import { resolveScmProviderFromEnv } from "./config";
import { createSourceControlProvider } from "./providers";
import type { SourceControlProvider } from "./types";

export function createSourceControlProviderFromEnv(env: Env): SourceControlProvider {
  const appConfig = getGitHubAppConfig(env);
  const provider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
  const userAgent = resolveAppName(env);
  const branchesCache = { store: env.REPOS_CACHE, getIdentity: () => reposCacheIdentity(env) };

  return createSourceControlProvider({
    provider,
    github: {
      appConfig: appConfig ?? undefined,
      cacheStore: env.REPOS_CACHE,
      branchesCache,
      userAgent,
    },
    ...(env.GITLAB_ACCESS_TOKEN
      ? {
          gitlab: {
            branchesCache,
            accessToken: env.GITLAB_ACCESS_TOKEN,
            namespace: env.GITLAB_NAMESPACE,
            userAgent,
          },
        }
      : {}),
  });
}
