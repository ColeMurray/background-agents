/**
 * Provider-specific types.
 */

import type { SourceControlTokenManager } from "../types";
import type { GitHubAppConfig } from "../../auth/github-app";

/**
 * Configuration for GitHubSourceControlProvider.
 */
export interface GitHubProviderConfig {
  /** Token manager for encryption/decryption */
  tokenManager: SourceControlTokenManager;
  /** GitHub App configuration (optional, for push auth) */
  appConfig?: GitHubAppConfig;
}
