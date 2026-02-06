/**
 * Source control provider module.
 *
 * Provides a pluggable abstraction for source control platforms
 * (GitHub, GitLab, Bitbucket) enabling unit testing and future provider support.
 */

// Types
export type {
  SourceControlProvider,
  SourceControlProviderName,
  SourceControlAuthContext,
  GitPushAuthContext,
  BuildManualPullRequestUrlConfig,
  BuildGitPushSpecConfig,
  GitPushSpec,
  RepositoryInfo,
  GetRepositoryConfig,
  CreatePullRequestConfig,
  CreatePullRequestResult,
} from "./types";

// Errors
export type { SourceControlErrorType } from "./errors";
export { SourceControlProviderError } from "./errors";

// Providers
export {
  GitHubSourceControlProvider,
  createGitHubProvider,
  createSourceControlProvider,
  type GitHubProviderConfig,
  type SourceControlProviderFactoryConfig,
} from "./providers";
