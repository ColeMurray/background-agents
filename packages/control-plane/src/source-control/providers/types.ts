/**
 * Provider-specific types.
 */

import type { GitHubAppConfig } from "../../auth/github-app";

/**
 * Configuration for GitHubSourceControlProvider.
 */
export interface GitHubProviderConfig {
  /** GitHub App configuration (required for push auth) */
  appConfig?: GitHubAppConfig;
  /** KV namespace for caching installation tokens */
  kvCache?: KVNamespace;
}
