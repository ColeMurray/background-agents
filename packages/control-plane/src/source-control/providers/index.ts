/**
 * Source control provider factory and exports.
 */

import { SourceControlProviderError } from "../errors";
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
    case "bitbucket":
      throw new SourceControlProviderError(
        "SCM provider 'bitbucket' is configured but not implemented.",
        "permanent"
      );
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
