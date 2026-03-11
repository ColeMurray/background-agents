/**
 * Source control provider module.
 *
 * Provides a pluggable abstraction for source control platforms
 * (currently GitHub and Bitbucket) enabling unit testing and future provider support.
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
  RepositoryAccessResult,
} from "./types";

// Errors
export type { SourceControlErrorType } from "./errors";
export { SourceControlProviderError } from "./errors";
export {
  DEFAULT_SCM_PROVIDER,
  getSourceControlProviderFactoryConfig,
  resolveScmProvider,
  resolveScmProviderFromEnv,
} from "./config";

// Providers
export {
  BitbucketSourceControlProvider,
  createBitbucketProvider,
  GitHubSourceControlProvider,
  createGitHubProvider,
  createSourceControlProvider,
  type BitbucketProviderConfig,
  type GitHubProviderConfig,
  type SourceControlProviderFactoryConfig,
} from "./providers";
