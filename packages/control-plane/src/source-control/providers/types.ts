/**
 * Provider-specific types.
 */

import type { GitHubAppConfig } from "../../auth/github-app";
import type { CacheStore } from "@open-inspect/shared/cache-store";
import type { BranchCacheConfig } from "../branch-cache";

/**
 * Configuration for GitHubSourceControlProvider.
 */
export interface GitHubProviderConfig {
  /** GitHub App configuration (required for push auth) */
  appConfig?: GitHubAppConfig;
  /** Cache store for caching installation tokens */
  cacheStore?: CacheStore;
  branchesCache?: BranchCacheConfig;
  /** User-Agent value sent on outbound GitHub API requests */
  userAgent?: string;
}

/**
 * Configuration for GitLabSourceControlProvider.
 */
export interface GitLabProviderConfig {
  branchesCache?: BranchCacheConfig;
  /** Personal access token for GitLab API access */
  accessToken: string;
  /** GitLab group namespace to scope repository listing (optional) */
  namespace?: string;
  /** User-Agent value sent on outbound GitLab API requests */
  userAgent?: string;
}
