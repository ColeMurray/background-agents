/**
 * Source control provider factory and exports.
 */

import { SourceControlProviderError } from "../errors";
import type { SourceControlProvider, SourceControlProviderName } from "../types";
import { createBitbucketProvider } from "./bitbucket-provider";
import { createGitHubProvider } from "./github-provider";
import type { BitbucketProviderConfig, GitHubProviderConfig } from "./types";

// Types
export type { GitHubProviderConfig, BitbucketProviderConfig } from "./types";

// Constants
export { USER_AGENT, GITHUB_API_BASE, BITBUCKET_API_BASE } from "./constants";

// Providers
export { GitHubSourceControlProvider, createGitHubProvider } from "./github-provider";
export { BitbucketSourceControlProvider, createBitbucketProvider } from "./bitbucket-provider";

/**
 * Factory configuration for selecting a source control provider.
 */
export interface SourceControlProviderFactoryConfig {
  provider: SourceControlProviderName;
  github?: GitHubProviderConfig;
  bitbucket?: BitbucketProviderConfig;
}

/**
 * Create a source control provider implementation for the given provider name.
 */
export function createSourceControlProvider(
  config: SourceControlProviderFactoryConfig
): SourceControlProvider {
  switch (config.provider) {
    case "github":
      return createGitHubProvider(config.github ?? {});
    case "bitbucket":
      return createBitbucketProvider(config.bitbucket ?? {});
    default: {
      const runtimeProvider = String(config.provider);
      const _exhaustive: never = config.provider;
      throw new SourceControlProviderError(
        `Unsupported source control provider: ${runtimeProvider}`,
        "permanent"
      );
    }
  }
}
