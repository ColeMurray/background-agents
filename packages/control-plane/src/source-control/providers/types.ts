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
}

/**
 * Configuration for BitbucketSourceControlProvider.
 */
export interface BitbucketProviderConfig {
  /** Bitbucket OAuth client ID (for potential token refresh flows) */
  oauthClientId?: string;
  /** Bitbucket OAuth client secret (for potential token refresh flows) */
  oauthClientSecret?: string;
  /** Bot username used for git push authentication */
  botUsername?: string;
  /** Bot app password used for git push authentication */
  botAppPassword?: string;
}
