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
export { DEFAULT_SCM_PROVIDER, resolveScmProviderFromEnv } from "./config";

// Providers
export {
  GitHubSourceControlProvider,
  BitbucketSourceControlProvider,
  createGitHubProvider,
  createBitbucketProvider,
  createSourceControlProvider,
  type GitHubProviderConfig,
  type BitbucketProviderConfig,
  type SourceControlProviderFactoryConfig,
} from "./providers";
