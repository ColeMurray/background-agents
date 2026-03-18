/**
 * Provider-specific types.
 */

import type { GitHubAppConfig } from "../../auth/github-app";
import type { GitHubUrls } from "../../github-urls";

/**
 * Configuration for GitHubSourceControlProvider.
 */
export interface GitHubProviderConfig {
  /** GitHub App configuration (required for push auth) */
  appConfig?: GitHubAppConfig;
  /** KV namespace for caching installation tokens */
  kvCache?: KVNamespace;
  /** Resolved GitHub URLs for GHES support. Defaults to github.com. */
  urls?: GitHubUrls;
}
