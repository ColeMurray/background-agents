/**
 * Source control provider factory and exports.
 */

import { SourceControlProviderError } from "../errors";
import type { SourceControlProvider, SourceControlProviderName } from "../types";
import { createGitHubProvider } from "./github-provider";
import { createGitLabProvider } from "./gitlab-provider";
import type { GitHubProviderConfig, GitLabProviderConfig } from "./types";

// Types
export type { GitHubProviderConfig, GitLabProviderConfig } from "./types";

// Constants
export { USER_AGENT, GITHUB_API_BASE } from "./constants";
export { GITLAB_API_BASE } from "./gitlab-provider";

// Providers
export { GitHubSourceControlProvider, createGitHubProvider } from "./github-provider";
export { GitLabSourceControlProvider, createGitLabProvider } from "./gitlab-provider";

/**
 * Factory configuration for selecting a source control provider.
 */
export interface SourceControlProviderFactoryConfig {
  provider: SourceControlProviderName;
  github?: GitHubProviderConfig;
  gitlab?: GitLabProviderConfig;
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
    case "gitlab":
      if (!config.gitlab) {
        throw new SourceControlProviderError(
          "SCM provider 'gitlab' requires gitlab configuration.",
          "permanent"
        );
      }
      return createGitLabProvider(config.gitlab);
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
