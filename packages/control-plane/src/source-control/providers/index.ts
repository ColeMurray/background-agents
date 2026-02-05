/**
 * Source control provider factory and exports.
 */

// Types
export type { GitHubProviderConfig } from "./types";

// Constants
export { USER_AGENT, GITHUB_API_BASE } from "./constants";

// Providers
export { GitHubSourceControlProvider, createGitHubProvider } from "./github-provider";
