/**
 * Source control provider factory and exports.
 */

import type { SourceControlProvider, SourceControlProviderName } from "../types";
import { createGitHubProvider } from "./github-provider";
import type { GitHubProviderConfig } from "./types";

// Types
export type { GitHubProviderConfig } from "./types";

// Constants
export { USER_AGENT, GITHUB_API_BASE } from "./constants";

// Providers
export { GitHubSourceControlProvider, createGitHubProvider } from "./github-provider";

/**
 * Factory configuration for selecting a source control provider.
 */
export interface SourceControlProviderFactoryConfig {
  provider: SourceControlProviderName;
  github?: GitHubProviderConfig;
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
    default: {
      const provider: never = config.provider;
      throw new Error(`Unsupported source control provider: ${String(provider)}`);
    }
  }
}
