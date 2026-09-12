/**
 * Source control provider types.
 *
 * Core interfaces and type definitions for source control platform abstraction.
 */

import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import type { PullRequestLifecycleState } from "@open-inspect/shared/types/artifacts";

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
export type SourceControlProviderName = "github" | "bitbucket" | "gitlab";

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
 * Credentials returned to a sandbox's git credential helper.
 *
 * Used by the long-lived sandbox to obtain fresh per-request credentials over
 * git's standard `credential get` protocol, so individual git operations
 * (fetch / push / ls-remote) survive past the credential's TTL without
 * requiring env-var or remote-URL rotation.
 */
export interface CredentialHelperAuth {
  /** Username component for HTTPS Basic auth (provider-specific). */
  username: string;
  /** Password component, typically a short-lived provider token. */
  password: string;
  /** Absolute epoch milliseconds when the password stops being valid. */
  expiresAtEpochMs: number;
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
  /** Target repository owner — selects the checkout in multi-repo sandboxes */
  repoOwner: string;
  /** Target repository name — selects the checkout in multi-repo sandboxes */
  repoName: string;
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
 * A commit-ish resolved to the commit it names.
 */
export interface ResolvedCommit {
  /** Full commit SHA. */
  sha: string;
}

/**
 * One entry in a recursive repository listing.
 */
export interface RepositoryTreeEntry {
  /** Repository-relative POSIX path. */
  path: string;
  /**
   * Entry kind. Anything a provider reports that is neither a file nor a
   * directory (submodule, symlink) is "other" — callers decide whether their
   * operation can proceed without it.
   */
  type: "file" | "directory" | "other";
  /** Provider blob ID, for files. */
  blobId: string;
  /**
   * Byte size when the provider reports one, otherwise null. Null means
   * unknown, never zero — a caller enforcing a size budget cannot treat a
   * listing as size-bearing unless every entry reports one.
   */
  sizeBytes: number | null;
  /** Whether the file carries the executable mode bit. */
  executable: boolean;
}

/**
 * A recursive repository listing at one commit.
 */
export interface RepositoryTree {
  entries: RepositoryTreeEntry[];
  /** True when the provider cut the listing short and entries are missing. */
  truncated: boolean;
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
  /**
   * Stored status facts (PR lifecycle tracking). Providers return only the
   * facts; consumers derive any display state with toDisplayStatus at their
   * own boundary, so a provider result can never carry an inconsistent pair.
   */
  lifecycleState: PullRequestLifecycleState;
  /** Stored status fact; only meaningful while open */
  isDraft: boolean;
  /** Source branch */
  sourceBranch: string;
  /** Target branch */
  targetBranch: string;
  /** Head commit SHA at creation, when the provider response carries it */
  headSha?: string;
  /** Stable provider repo id (canonical PR identity), when carried */
  repositoryExternalId?: string;
  /**
   * Provider's updated_at (epoch ms) from the create response, when carried.
   * Seeds the monotonic guard so a creation write cannot regress a webhook
   * for the same PR that landed first.
   */
  providerUpdatedAt?: number;
}

/**
 * Configuration for reading a pull request's current state.
 */
export interface GetPullRequestConfig {
  /** Repository owner */
  owner: string;
  /** Repository name */
  name: string;
  /** Pull request number */
  number: number;
  /**
   * Stable provider repo id, when known. Enables rename/transfer tolerance:
   * on a 404 the provider re-resolves the repository's current location by
   * id and retries once.
   */
  repositoryExternalId?: string;
}

/**
 * Snapshot of a pull request's current provider state.
 *
 * Field names mirror PullRequestArtifactMetadata (shared) so the snapshot
 * flows into the D1 record and DO artifact without a mapping layer;
 * lifecycleState/isDraft structurally satisfy PullRequestStatus.
 */
export interface PullRequestSnapshot {
  number: number;
  /** Web URL of the pull request */
  url: string;
  lifecycleState: PullRequestLifecycleState;
  /** Draft readiness; false whenever the PR is not open (invariant) */
  isDraft: boolean;
  /** Head (source) branch name */
  headBranch: string;
  /** Base (target) branch name */
  baseBranch: string;
  headSha?: string;
  /** Canonical current owner (refreshed when a rename/transfer is detected) */
  repoOwner: string;
  /** Canonical current name (refreshed when a rename/transfer is detected) */
  repoName: string;
  /** Stable provider repo id */
  repositoryExternalId?: string;
  /** Provider's created_at (epoch ms) — analytics cohort bucketing */
  providerCreatedAt?: number;
  /** Provider's updated_at (epoch ms) — the monotonic write guard source */
  providerUpdatedAt?: number;
  /** Provider's merged_at (epoch ms); only meaningful when merged */
  mergedAt?: number;
  /** Provider's closed_at (epoch ms); only meaningful when not open */
  closedAt?: number;
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
  readonly name: SourceControlProviderName;

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
   * Resolve one branch tip with app-level credentials. A confirmed 404 is
   * absence; authentication, throttling, and transport failures throw.
   */
  getBranchHead(config: GetRepositoryConfig & { branch: string }): Promise<string | null>;

  /**
   * Resolve a branch, tag, or commit-ish to the commit it names.
   *
   * App-authenticated. A confirmed 404 is absence (null); authentication,
   * throttling, and transport failures throw.
   *
   * @param config - Repository identifier plus the ref to resolve
   * @returns The resolved commit, or null when the ref does not exist
   * @throws SourceControlProviderError
   */
  resolveCommit(config: GetRepositoryConfig & { ref: string }): Promise<ResolvedCommit | null>;

  /**
   * List every entry reachable from a commit, recursively.
   *
   * App-authenticated. Providers cap how much tree they will return in one
   * response; `truncated` reports that cap being hit so callers can refuse to
   * act on a partial listing rather than silently dropping entries.
   *
   * @param config - Repository identifier plus the commit and optional subtree to read
   * @throws SourceControlProviderError
   */
  listTree(
    config: GetRepositoryConfig & { commitSha: string; path?: string | null }
  ): Promise<RepositoryTree>;

  /**
   * Read one blob's raw bytes by its provider blob ID.
   *
   * App-authenticated. Blob IDs come from `listTree`, so the content read is
   * pinned to the same commit no matter what the ref does meanwhile.
   *
   * `maxBytes` is a refusal threshold, not a truncation point: a blob the
   * provider can tell is larger is rejected before its body is buffered, so a
   * caller with a size budget never has to hold an oversized blob in memory to
   * discover it is oversized. Providers that cannot know the size up front
   * still return the full body, so callers must re-check what they receive.
   *
   * @param config - Repository identifier, the blob ID from listTree, and the
   *   largest body the caller is willing to accept
   * @throws SourceControlProviderError, including when the blob is too large
   */
  readBlob(config: GetRepositoryConfig & { blobId: string; maxBytes: number }): Promise<Uint8Array>;

  /**
   * Read the current state of a pull request.
   *
   * App-authenticated: credentials come from provider-level configuration
   * (matching listRepositories), never a caller token — the webhook and
   * read-through freshness paths run with no user in the loop.
   *
   * @param config - PR identifier; include repositoryExternalId when known
   *   so a 404 triggers a resolve-by-id + single retry (rename tolerance)
   * @returns Current PR snapshot
   * @throws SourceControlProviderError
   */
  getPullRequest(config: GetPullRequestConfig): Promise<PullRequestSnapshot>;

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
   * Generate credentials for the sandbox's git credential helper.
   *
   * Called per request from inside the sandbox via
   * `POST /sessions/:id/scm-credentials`. The returned `username` is the
   * provider-specific basic-auth username (e.g. `x-access-token` for GitHub),
   * and `password` is a freshly minted token. `expiresAtEpochMs` lets the
   * client side cache the credentials until shortly before they expire.
   *
   * @throws SourceControlProviderError on configuration or upstream errors
   */
  generateCredentialHelperAuth(): Promise<CredentialHelperAuth>;

  /**
   * Build provider-specific URL for manual pull request creation.
   */
  buildManualPullRequestUrl(config: BuildManualPullRequestUrlConfig): string;

  /**
   * Build provider-specific git push specification for bridge execution.
   */
  buildGitPushSpec(config: BuildGitPushSpecConfig): GitPushSpec;
}

/** App-authenticated repository capabilities required by managed-skill imports. */
export type RepositoryReader = Pick<
  SourceControlProvider,
  "name" | "checkRepositoryAccess" | "resolveCommit" | "listTree" | "readBlob"
>;
