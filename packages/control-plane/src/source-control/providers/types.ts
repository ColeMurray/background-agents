/**
 * Provider-specific types.
 */

import type { GitHubAppConfig } from "../../auth/github-app";

/**
 * Configuration for GitHubSourceControlProvider.
 */
export interface GitHubProviderConfig {
  /** GitHub App configuration for the primary installation (required for push auth) */
  appConfig?: GitHubAppConfig;
  /** All GitHub App configurations (one per installation). Used for listing repos and checking access. */
  allAppConfigs?: GitHubAppConfig[];
  /** KV namespace for caching installation tokens */
  kvCache?: KVNamespace;
}
