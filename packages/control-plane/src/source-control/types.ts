/**
 * Source control provider types.
 *
 * Core interfaces and type definitions for source control platform abstraction.
 */

/**
 * Capabilities supported by a source control provider.
 * Providers can support different feature sets.
 */
export interface SourceControlProviderCapabilities {
  /** Whether the provider supports pull/merge requests */
  supportsPullRequests: boolean;
  /** Whether the provider supports draft pull/merge requests */
  supportsDraftPullRequests: boolean;
  /** Whether the provider supports reviewers on pull/merge requests */
  supportsReviewers: boolean;
  /** Whether the provider supports labels on pull/merge requests */
  supportsLabels: boolean;
  /** Whether the provider supports protected branches */
  supportsProtectedBranches: boolean;
  /** Whether the provider supports app authentication (GitHub Apps, GitLab deploy tokens) */
  supportsAppAuth: boolean;
}

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
 * Authentication context for source control API operations.
 */
export interface SourceControlAuthContext {
  /** Type of authentication */
  authType: "oauth" | "pat" | "token";
  /** Encrypted access token */
  encryptedToken: string;
  /** Encrypted refresh token (for OAuth) */
  encryptedRefreshToken?: string;
  /** Token expiry timestamp in milliseconds */
  expiresAt?: number;
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
 * Configuration for retrieving repository information.
 */
export interface GetRepositoryConfig {
  /** Repository owner */
  owner: string;
  /** Repository name */
  name: string;
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
 * Token manager interface.
 *
 * Provides a clean abstraction over token encryption/decryption
 * for source control providers.
 */
export interface SourceControlTokenManager {
  /**
   * Decrypt an encrypted token.
   *
   * @param encryptedToken - Base64-encoded encrypted token
   * @returns Decrypted plain text token
   */
  decrypt(encryptedToken: string): Promise<string>;

  /**
   * Encrypt a plain text token.
   *
   * @param plainToken - Plain text token to encrypt
   * @returns Base64-encoded encrypted token
   */
  encrypt(plainToken: string): Promise<string>;
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
 * const provider: SourceControlProvider = new GitHubSourceControlProvider(config);
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

  /** Provider capabilities */
  readonly capabilities: SourceControlProviderCapabilities;

  /**
   * Get repository information including default branch.
   *
   * @param auth - Authentication context with encrypted token
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
   * @param auth - Authentication context with encrypted token
   * @param config - Pull request configuration
   * @returns Pull request result with URL and ID
   * @throws SourceControlProviderError
   */
  createPullRequest(
    auth: SourceControlAuthContext,
    config: CreatePullRequestConfig
  ): Promise<CreatePullRequestResult>;

  /**
   * Generate authentication for git push operations.
   *
   * Returns a decrypted token that can be sent to the sandbox
   * for git push authentication.
   *
   * @returns Git push authentication context
   * @throws SourceControlProviderError
   */
  generatePushAuth(): Promise<GitPushAuthContext>;
}
