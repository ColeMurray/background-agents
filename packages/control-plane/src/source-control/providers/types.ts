/**
 * Provider-specific types.
 */

import type { GitHubAppConfig } from "../../auth/github-app";

/**
 * Configuration for GitHubSourceControlProvider.
 */
export interface GitHubProviderConfig {
  /** GitHub App configuration (required for push auth) — primary installation */
  appConfig?: GitHubAppConfig;
  /** All GitHub App configs (for multi-installation support) */
  allAppConfigs?: GitHubAppConfig[];
  /** KV namespace for caching installation tokens */
  kvCache?: KVNamespace;
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
