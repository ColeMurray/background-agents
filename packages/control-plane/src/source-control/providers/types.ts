/**
 * Provider-specific types.
 */

import type { GitHubAppConfig } from "../../auth/github-app";
import type { CacheStore } from "../../cache/cache-store";

/**
 * Configuration for GitHubSourceControlProvider.
 */
export interface GitHubProviderConfig {
  /** GitHub App configuration (required for push auth) */
  appConfig?: GitHubAppConfig;
  /** Cache store for caching installation tokens */
  cacheStore?: CacheStore;
}

/**
 * Configuration for GitLabSourceControlProvider.
 */
export interface GitLabProviderConfig {
  /** Personal access token for GitLab API access */
  accessToken: string;
  /** GitLab group namespace to scope repository listing (optional) */
  namespace?: string;
}
