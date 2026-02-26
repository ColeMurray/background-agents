/**
 * Source control provider types.
 *
 * Core interfaces and type definitions for source control platform abstraction.
 */

import type { InstallationRepository } from "@open-inspect/shared";

/**
 * Repository information.
 */
export interface RepositoryInfo {
  /** Repository owner (user or organization) */
  owner: string;
  /** Repository name */
  name: string;
  /** Full repository name (owner/name) */
  fullName: string;
  /** Default branch name */
  defaultBranch: string;
  /** Whether the repository is private */
  isPrivate: boolean;
  /** Provider-specific repository ID */
  providerRepoId: string | number;
}

/**
 * Supported source control provider names.
 */
export type SourceControlProviderName = "github" | "bitbucket";

/**
 * Authentication context for source control API operations.
 *
 * Contains plain (decrypted) tokens. The session layer is responsible
 * for decrypting tokens before constructing this context.
 */
export interface SourceControlAuthContext {
  /** Type of authentication */
  authType: "oauth" | "pat" | "app";
  /** Plain access token for API calls */
  token: string;
}

/**
 * Authentication context for git push operations.
 * Contains decrypted token to be sent to sandbox.
 */
export interface GitPushAuthContext {
  /** Type of authentication */
  authType: "app" | "pat" | "token";
  /** Decrypted token for git operations */
  token: string;
}

/**
 * Configuration for building a manual pull-request URL.
 */
export interface BuildManualPullRequestUrlConfig {
  /** Repository owner */
  owner: string;
  /** Repository name */
  name: string;
  /** Source branch (branch with changes) */
  sourceBranch: string;
  /** Target branch (branch to merge into) */
  targetBranch: string;
}

/**
 * Configuration for building a provider-specific git push specification.
 */
export interface BuildGitPushSpecConfig {
  /** Repository owner */
  owner: string;
  /** Repository name */
  name: string;
  /** Local ref to push from (e.g. HEAD) */
  sourceRef: string;
  /** Remote branch to push to */
  targetBranch: string;
  /** Authentication context for git push operations */
  auth: GitPushAuthContext;
  /** Whether to force push */
  force?: boolean;
}

/**
 * Provider-specific git push specification.
 *
 * The bridge uses this spec to perform git push without embedding provider logic.
 */
export interface GitPushSpec {
  /** Remote URL including credentials */
  remoteUrl: string;
  /** Redacted form for safe logging */
  redactedRemoteUrl: string;
  /** Refspec in format <src>:<dst> */
  refspec: string;
  /** Remote branch name (for observability and event correlation) */
  targetBranch: string;
  /** Whether force push is required */
  force: boolean;
}

/**
 * Configuration for retrieving repository information.
 */
export interface GetRepositoryConfig {
  /** Repository owner */
  owner: string;
  /** Repository name */
  name: string;
}

/**
 * Result of checking repository access via app-level credentials.
 */
export interface RepositoryAccessResult {
  /** Provider-specific numeric repository ID */
  repoId: number;
  /** Normalized (lowercase) repository owner */
  repoOwner: string;
  /** Normalized (lowercase) repository name */
  repoName: string;
  /** Repository's default branch (e.g., "main") */
  defaultBranch: string;
}

/**
 * Configuration for creating a pull request.
 */
export interface CreatePullRequestConfig {
  /** Repository information */
  repository: RepositoryInfo;
  /** Pull request title */
  title: string;
  /** Pull request body/description */
  body: string;
  /** Source branch (branch with changes) */
  sourceBranch: string;
  /** Target branch (branch to merge into) */
  targetBranch: string;
  /** Whether to create as draft (if supported) */
  draft?: boolean;
  /** Labels to apply (if supported) */
  labels?: string[];
  /** Reviewers to request (if supported) */
  reviewers?: string[];
}

/**
 * Result of creating a pull request.
 */
export interface CreatePullRequestResult {
  /** Pull request number/ID */
  id: number;
  /** Web URL for the pull request */
  webUrl: string;
  /** API URL for the pull request */
  apiUrl: string;
  /** Current state of the pull request */
  state: "open" | "closed" | "merged" | "draft";
  /** Source branch */
  sourceBranch: string;
  /** Target branch */
  targetBranch: string;
}

/**
 * Source control provider interface.
 *
 * Defines the contract for source control platform operations.
 * Implementations wrap provider-specific APIs (GitHub, GitLab, Bitbucket).
 *
 * Error handling:
 * - Methods should throw SourceControlProviderError with appropriate errorType
 * - "transient" errors (network issues) can be retried
 * - "permanent" errors (config issues) should not be retried
 *
 * @example
 * ```typescript
 * const provider: SourceControlProvider = createGitHubProvider({ appConfig });
 *
 * // Session layer decrypts token before calling provider
 * const token = await decryptToken(encryptedToken, encryptionKey);
 * const auth: SourceControlAuthContext = { authType: "oauth", token };
 *
 * try {
 *   const repo = await provider.getRepository(auth, { owner: "acme", name: "app" });
 *   const pr = await provider.createPullRequest(auth, {
 *     repository: repo,
 *     title: "Add feature",
 *     body: "Description",
 *     sourceBranch: "feature-branch",
 *     targetBranch: repo.defaultBranch,
 *   });
 *   console.log("Created PR:", pr.webUrl);
 * } catch (e) {
 *   if (e instanceof SourceControlProviderError && e.errorType === "transient") {
 *     // Retry logic
 *   }
 * }
 * ```
 */
export interface SourceControlProvider {
  /** Provider name for logging and debugging */
  readonly name: string;

  //
  // User-authenticated operations
  // These methods require a user's OAuth/PAT token to act on their behalf.
  //

  /**
   * Get repository information including default branch.
   *
   * @param auth - Authentication context with plain token
   * @param config - Repository identifier (owner/name)
   * @returns Repository information
   * @throws SourceControlProviderError
   */
  getRepository(
    auth: SourceControlAuthContext,
    config: GetRepositoryConfig
  ): Promise<RepositoryInfo>;

  /**
   * Create a pull request.
   *
   * @param auth - Authentication context with plain token
   * @param config - Pull request configuration
   * @returns Pull request result with URL and ID
   * @throws SourceControlProviderError
   */
  createPullRequest(
    auth: SourceControlAuthContext,
    config: CreatePullRequestConfig
  ): Promise<CreatePullRequestResult>;

  //
  // App-authenticated operations
  // These methods use app-level credentials (e.g., GitHub App installation token)
  // configured at provider construction time, not user tokens.
  //

  /**
   * Check whether a specific repository is accessible to this deployment's
   * app-level credentials (e.g. GitHub App installation).
   *
   * @param config - Repository identifier (owner/name)
   * @returns Access result with normalized identifiers, or null if not accessible
   * @throws SourceControlProviderError on configuration errors
   */
  checkRepositoryAccess(config: GetRepositoryConfig): Promise<RepositoryAccessResult | null>;

  /**
   * List all repositories accessible to this deployment's app-level credentials.
   *
   * @returns Array of installation repositories
   * @throws SourceControlProviderError on configuration or API errors
   */
  listRepositories(): Promise<InstallationRepository[]>;

  /**
   * List branches for a repository.
   *
   * @param config - Repository identifier (owner/name)
   * @returns Array of branch names
   * @throws SourceControlProviderError on configuration or API errors
   */
  listBranches(config: GetRepositoryConfig): Promise<{ name: string }[]>;

  /**
   * Generate authentication for git push operations.
   *
   * Uses app-level credentials (configured at provider construction) rather than
   * user auth because push operations run in the sandbox, which shouldn't have
   * access to user OAuth tokens.
   *
   * @returns Git push authentication context with app token
   * @throws SourceControlProviderError
   */
  generatePushAuth(): Promise<GitPushAuthContext>;

  /**
   * Build provider-specific URL for manual pull request creation.
   */
  buildManualPullRequestUrl(config: BuildManualPullRequestUrlConfig): string;

  /**
   * Build provider-specific git push specification for bridge execution.
   */
  buildGitPushSpec(config: BuildGitPushSpecConfig): GitPushSpec;
}
