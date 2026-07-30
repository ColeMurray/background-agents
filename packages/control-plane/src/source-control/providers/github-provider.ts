/**
 * GitHub source control provider implementation.
 *
 * Implements the SourceControlProvider interface for GitHub,
 * wrapping existing GitHub API functions.
 */

import { z } from "zod";
import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import type { PullRequestStatus } from "@open-inspect/shared";
import type {
  SourceControlProvider,
  SourceControlAuthContext,
  GetRepositoryConfig,
  RepositoryAccessResult,
  RepositoryInfo,
  CreatePullRequestConfig,
  CreatePullRequestResult,
  GetPullRequestConfig,
  PullRequestSnapshot,
  BuildManualPullRequestUrlConfig,
  BuildGitPushSpecConfig,
  GitPushSpec,
  GitPushAuthContext,
  CredentialHelperAuth,
} from "../types";
import { SourceControlProviderError, parseProviderResponse } from "../errors";
import {
  getCachedInstallationToken,
  getCachedInstallationTokenWithExpiry,
  getInstallationRepository,
  listInstallationRepositories,
  listRepositoryBranches,
  fetchWithTimeout,
} from "../../auth/github-app";
import type { GitHubProviderConfig } from "./types";
import { USER_AGENT, GITHUB_API_BASE } from "./constants";

/** Extract HTTP status from upstream errors (GitHubHttpError has a .status property). */
function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

/** GitHub pull-request state fields as the REST API reports them. */
interface GitHubPullRequestStateFields {
  /** GitHub's wire state is strictly open/closed; merged is a separate flag. */
  state: "open" | "closed";
  draft?: boolean | null;
  merged?: boolean | null;
}

/**
 * Pure mapping from GitHub's PR state fields to the stored status. GitHub
 * models merged as state "closed" + merged true; terminal states win over a
 * stale draft flag (isDraft is only meaningful while open). Shared by
 * createPullRequest (user-authed) and getPullRequest (app-authed).
 */
export function deriveGitHubPullRequestStatus(
  data: GitHubPullRequestStateFields
): PullRequestStatus {
  if (data.merged) return { lifecycleState: "merged", isDraft: false };
  if (data.state === "closed") return { lifecycleState: "closed", isDraft: false };
  return { lifecycleState: "open", isDraft: data.draft === true };
}

/**
 * Wire schema of a GitHub REST pull request, limited to the fields we read.
 * `state` is a strict enum — an unexpected value is schema drift and fails
 * the parse rather than being coerced into an apparently-valid status.
 */
const githubPullResponseSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().nullable().optional(),
  merged: z.boolean().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  merged_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string().optional() }),
  base: z.object({
    ref: z.string(),
    repo: z
      .object({
        id: z.number().optional(),
        name: z.string().optional(),
        owner: z.object({ login: z.string().optional() }).optional(),
      })
      .nullable()
      .optional(),
  }),
});

/** Wire shape of GET /repositories/{id}, limited to the location fields. */
const githubRepositoryLocationSchema = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
});

/** Wire shape of GET /repos/{owner}/{repo}, limited to fields used for repo metadata. */
const githubRepositoryInfoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  owner: z.object({ login: z.string() }),
});

/** Wire shape of a GitHub git-ref response, limited to the branch head SHA. */
const githubBranchRefSchema = z.object({
  object: z.object({ sha: z.string().min(1) }),
});

const githubFeedbackAuthorSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
});

const githubPullRequestCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  html_url: z.url(),
  issue_url: z.url(),
  user: githubFeedbackAuthorSchema,
});

const githubPullRequestReviewSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  html_url: z.url(),
  state: z.enum(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]),
  user: githubFeedbackAuthorSchema,
});

const githubReviewCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  html_url: z.url(),
  path: z.string(),
  line: z.number().nullable().optional(),
  start_line: z.number().nullable().optional(),
  side: z.string().nullable().optional(),
  start_side: z.string().nullable().optional(),
  diff_hunk: z.string(),
});

const githubCollaboratorPermissionSchema = z.object({
  permission: z.enum(["none", "read", "triage", "write", "maintain", "admin"]),
});

interface GitHubPullRequestFeedbackLocation {
  owner: string;
  name: string;
  pullRequestNumber: number;
}

export type GetGitHubPullRequestFeedbackConfig = GitHubPullRequestFeedbackLocation &
  (
    | { providerObject: { kind: "pr_comment"; id: string } }
    | { providerObject: { kind: "review"; id: string } }
  );

export interface GitHubFeedbackAuthor {
  id: string;
  login: string;
  type: string;
}

export type GitHubPullRequestFeedback =
  | {
      kind: "pr_comment";
      id: string;
      body: string;
      url: string;
      author: GitHubFeedbackAuthor;
    }
  | {
      kind: "review";
      id: string;
      body: string;
      url: string;
      state: "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
      author: GitHubFeedbackAuthor;
      comments: GitHubReviewComment[];
    };

export interface GitHubReviewComment {
  id: string;
  body: string;
  url: string;
  path: string;
  line: number | null;
  startLine: number | null;
  side: string | null;
  startSide: string | null;
  diffHunk: string;
}

/** Parse a GitHub ISO-8601 timestamp into epoch ms; undefined when absent/invalid. */
function parseProviderTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * GitHub implementation of SourceControlProvider.
 */
export class GitHubSourceControlProvider implements SourceControlProvider {
  readonly name = "github";

  private readonly appConfig?: GitHubProviderConfig["appConfig"];
  private readonly cacheStore?: GitHubProviderConfig["cacheStore"];
  private readonly userAgent: string;

  constructor(config: GitHubProviderConfig = {}) {
    this.appConfig = config.appConfig;
    this.cacheStore = config.cacheStore;
    this.userAgent = config.userAgent || USER_AGENT;
  }

  async getPullRequestFeedback(
    config: GetGitHubPullRequestFeedbackConfig
  ): Promise<GitHubPullRequestFeedback> {
    const token = await this.getAppToken("get pull request feedback");
    if (config.providerObject.kind === "review") {
      return this.getPullRequestReviewFeedback(token, config, config.providerObject.id);
    }

    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}/issues/comments/${encodeURIComponent(config.providerObject.id)}`,
      { headers: this.appHeaders(token) }
    );
    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get pull request comment: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = await parseProviderResponse(
      response,
      githubPullRequestCommentSchema,
      "Failed to get pull request comment"
    );
    const expectedIssuePath =
      `/repos/${config.owner}/${config.name}/issues/${config.pullRequestNumber}`.toLowerCase();
    if (
      String(data.id) !== config.providerObject.id ||
      new URL(data.issue_url).pathname.toLowerCase() !== expectedIssuePath
    ) {
      throw new SourceControlProviderError(
        "Pull request comment does not belong to the requested pull request",
        "permanent"
      );
    }

    return {
      kind: "pr_comment",
      id: String(data.id),
      body: data.body,
      url: data.html_url,
      author: {
        id: String(data.user.id),
        login: data.user.login,
        type: data.user.type,
      },
    };
  }

  async hasPullRequestWritePermission(config: {
    owner: string;
    name: string;
    authorLogin: string;
  }): Promise<boolean> {
    const token = await this.getAppToken("check pull request author permission");
    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}/collaborators/${encodeURIComponent(config.authorLogin)}/permission`,
      { headers: this.appHeaders(token) }
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get collaborator permission: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const { permission } = await parseProviderResponse(
      response,
      githubCollaboratorPermissionSchema,
      "Failed to get collaborator permission"
    );
    return permission === "write" || permission === "maintain" || permission === "admin";
  }

  private async getPullRequestReviewFeedback(
    token: string,
    config: GitHubPullRequestFeedbackLocation,
    reviewId: string
  ): Promise<Extract<GitHubPullRequestFeedback, { kind: "review" }>> {
    const reviewUrl = `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}/pulls/${config.pullRequestNumber}/reviews/${encodeURIComponent(reviewId)}`;
    const reviewResponse = await fetchWithTimeout(reviewUrl, {
      headers: this.appHeaders(token),
    });
    if (!reviewResponse.ok) {
      const error = await reviewResponse.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get pull request review: ${reviewResponse.status} ${error}`,
        new Error(error),
        reviewResponse.status
      );
    }
    const review = await parseProviderResponse(
      reviewResponse,
      githubPullRequestReviewSchema,
      "Failed to get pull request review"
    );
    if (String(review.id) !== reviewId) {
      throw new SourceControlProviderError(
        "Pull request review identity did not match the requested review",
        "permanent"
      );
    }

    const comments: GitHubReviewComment[] = [];
    for (let page = 1; ; page += 1) {
      const commentsResponse = await fetchWithTimeout(
        `${reviewUrl}/comments?per_page=100&page=${page}`,
        { headers: this.appHeaders(token) }
      );
      if (!commentsResponse.ok) {
        const error = await commentsResponse.text();
        throw SourceControlProviderError.fromFetchError(
          `Failed to get pull request review comments: ${commentsResponse.status} ${error}`,
          new Error(error),
          commentsResponse.status
        );
      }
      const pageComments = await parseProviderResponse(
        commentsResponse,
        z.array(githubReviewCommentSchema),
        "Failed to get pull request review comments"
      );
      comments.push(
        ...pageComments.map((comment) => ({
          id: String(comment.id),
          body: comment.body,
          url: comment.html_url,
          path: comment.path,
          line: comment.line ?? null,
          startLine: comment.start_line ?? null,
          side: comment.side ?? null,
          startSide: comment.start_side ?? null,
          diffHunk: comment.diff_hunk,
        }))
      );
      if (pageComments.length < 100) break;
    }

    return {
      kind: "review",
      id: String(review.id),
      body: review.body ?? "",
      url: review.html_url,
      state: review.state,
      author: {
        id: String(review.user.id),
        login: review.user.login,
        type: review.user.type,
      },
      comments,
    };
  }

  private async getAppToken(operation: string): Promise<string> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        `GitHub App not configured - cannot ${operation}`,
        "permanent"
      );
    }
    try {
      return await getCachedInstallationToken(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub App token: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  private appHeaders(token: string): Record<string, string> {
    return {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": this.userAgent,
    };
  }

  /**
   * Get repository information from GitHub API.
   */
  async getRepository(
    auth: SourceControlAuthContext,
    config: GetRepositoryConfig
  ): Promise<RepositoryInfo> {
    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${auth.token}`,
          "User-Agent": this.userAgent,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get repository: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = await parseProviderResponse(
      response,
      githubRepositoryInfoSchema,
      "Failed to get repository"
    );

    return {
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      isPrivate: data.private,
      providerRepoId: data.id,
    };
  }

  /**
   * Create a pull request on GitHub.
   */
  async createPullRequest(
    auth: SourceControlAuthContext,
    config: CreatePullRequestConfig
  ): Promise<CreatePullRequestResult> {
    const requestBody: Record<string, unknown> = {
      title: config.title,
      body: config.body,
      head: config.sourceBranch,
      base: config.targetBranch,
    };

    // Add draft flag if requested and supported
    if (config.draft) {
      requestBody.draft = true;
    }

    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.repository.owner}/${config.repository.name}/pulls`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${auth.token}`,
          "User-Agent": this.userAgent,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to create PR: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = await parseProviderResponse(
      response,
      githubPullResponseSchema,
      "Failed to create PR"
    );

    const repositoryExternalId = data.base.repo?.id;
    const status = deriveGitHubPullRequestStatus(data);
    const result: CreatePullRequestResult = {
      id: data.number,
      webUrl: data.html_url,
      apiUrl: data.url,
      lifecycleState: status.lifecycleState,
      isDraft: status.isDraft,
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
      headSha: data.head.sha,
      repositoryExternalId:
        repositoryExternalId !== undefined ? String(repositoryExternalId) : undefined,
      providerUpdatedAt: parseProviderTimestamp(data.updated_at),
    };

    // Add labels if requested
    if (config.labels && config.labels.length > 0) {
      await this.addLabels(
        auth.token,
        config.repository.owner,
        config.repository.name,
        data.number,
        config.labels
      );
    }

    // Request reviewers if requested
    if (config.reviewers && config.reviewers.length > 0) {
      await this.requestReviewers(
        auth.token,
        config.repository.owner,
        config.repository.name,
        data.number,
        config.reviewers
      );
    }

    return result;
  }

  /**
   * Read the current state of a pull request using GitHub App credentials.
   *
   * On a 404 with a known stable repo id, re-resolves the repository's
   * current owner/name by id and retries once (rename/transfer tolerance).
   */
  async getPullRequest(config: GetPullRequestConfig): Promise<PullRequestSnapshot> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot get pull request",
        "permanent"
      );
    }

    let token: string;
    try {
      token = await getCachedInstallationToken(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub App token: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }

    let response = await this.fetchPullRequest(token, config.owner, config.name, config.number);

    if (response.status === 404 && config.repositoryExternalId) {
      const resolved = await this.resolveRepositoryLocationById(token, config.repositoryExternalId);
      if (resolved) {
        response = await this.fetchPullRequest(token, resolved.owner, resolved.name, config.number);
      }
    }

    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get pull request: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = await parseProviderResponse(
      response,
      githubPullResponseSchema,
      "Failed to get pull request"
    );
    const status = deriveGitHubPullRequestStatus(data);
    const repositoryExternalId = data.base.repo?.id;

    return {
      number: data.number,
      url: data.html_url,
      lifecycleState: status.lifecycleState,
      isDraft: status.isDraft,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      headSha: data.head.sha,
      // The response's base repo is authoritative for the current location.
      repoOwner: data.base.repo?.owner?.login ?? config.owner,
      repoName: data.base.repo?.name ?? config.name,
      repositoryExternalId:
        repositoryExternalId !== undefined
          ? String(repositoryExternalId)
          : config.repositoryExternalId,
      providerCreatedAt: parseProviderTimestamp(data.created_at),
      providerUpdatedAt: parseProviderTimestamp(data.updated_at),
      mergedAt: parseProviderTimestamp(data.merged_at),
      closedAt: parseProviderTimestamp(data.closed_at),
    };
  }

  private fetchPullRequest(
    token: string,
    owner: string,
    name: string,
    number: number
  ): Promise<Response> {
    return fetchWithTimeout(`${GITHUB_API_BASE}/repos/${owner}/${name}/pulls/${number}`, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": this.userAgent,
      },
    });
  }

  /**
   * Resolve a repository's current owner/name from its stable numeric id.
   *
   * GET /repositories/{id} is GitHub's stable-but-undocumented by-id alias of
   * GET /repos/{owner}/{name} (identical response schema; acknowledged by
   * GitHub staff). Acceptable here because this is a best-effort repair path:
   * if the endpoint ever disappears, resolution degrades to "not resolved"
   * and the caller surfaces the original 404.
   */
  private async resolveRepositoryLocationById(
    token: string,
    repositoryExternalId: string
  ): Promise<{ owner: string; name: string } | null> {
    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repositories/${encodeURIComponent(repositoryExternalId)}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    // Best-effort repair path: a malformed resolution body degrades to "not
    // resolved" so the caller surfaces the original 404 instead.
    const parsed = githubRepositoryLocationSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!parsed.success) {
      return null;
    }
    return { owner: parsed.data.owner.login, name: parsed.data.name };
  }

  /**
   * Check whether a repository is accessible to the GitHub App installation.
   */
  async checkRepositoryAccess(config: GetRepositoryConfig): Promise<RepositoryAccessResult | null> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot check repository access",
        "permanent"
      );
    }

    try {
      const repo = await getInstallationRepository(this.appConfig, config.owner, config.name, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      if (!repo) {
        return null;
      }
      if (repo.archived) {
        return null;
      }
      return {
        repoId: repo.id,
        repoOwner: config.owner.toLowerCase(),
        repoName: config.name.toLowerCase(),
        defaultBranch: repo.defaultBranch,
      };
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to check repository access: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /**
   * List all repositories accessible to the GitHub App installation.
   */
  async listRepositories(): Promise<InstallationRepository[]> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot list repositories",
        "permanent"
      );
    }

    try {
      const result = await listInstallationRepositories(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      return result.repos.filter((repo) => !repo.archived);
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to list repositories: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /**
   * List branches for a repository.
   */
  async listBranches(config: GetRepositoryConfig): Promise<{ name: string }[]> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot list branches",
        "permanent"
      );
    }

    try {
      return await listRepositoryBranches(this.appConfig, config.owner, config.name, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to list branches: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  async getBranchHead(config: GetRepositoryConfig & { branch: string }): Promise<string | null> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot resolve branch head",
        "permanent"
      );
    }
    try {
      const token = await getCachedInstallationToken(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      const response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
          config.name
        )}/git/ref/heads/${encodeURIComponent(config.branch)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": this.userAgent,
          },
        }
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        const error = await response.text();
        throw SourceControlProviderError.fromFetchError(
          `Failed to resolve branch head: ${response.status} ${error}`,
          new Error(error),
          response.status
        );
      }
      const data = await parseProviderResponse(
        response,
        githubBranchRefSchema,
        "Failed to resolve branch head"
      );
      return data.object.sha;
    } catch (error) {
      if (error instanceof SourceControlProviderError) throw error;
      throw SourceControlProviderError.fromFetchError(
        `Failed to resolve branch head: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  /**
   * Generate authentication for git push operations using GitHub App.
   */
  async generatePushAuth(): Promise<GitPushAuthContext> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot generate push auth",
        "permanent"
      );
    }

    try {
      const token = await getCachedInstallationToken(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
      return {
        authType: "app",
        token,
      };
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub App token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async generateCredentialHelperAuth(): Promise<CredentialHelperAuth> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot generate credential helper auth",
        "permanent"
      );
    }

    try {
      const { token, expiresAtEpochMs } = await getCachedInstallationTokenWithExpiry(
        this.appConfig,
        {
          cacheStore: this.cacheStore,
          userAgent: this.userAgent,
        }
      );
      return {
        username: "x-access-token",
        password: token,
        expiresAtEpochMs,
      };
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub credential helper auth: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  buildManualPullRequestUrl(config: BuildManualPullRequestUrlConfig): string {
    const encodedOwner = encodeURIComponent(config.owner);
    const encodedName = encodeURIComponent(config.name);
    const encodedBase = encodeURIComponent(config.targetBranch);
    const encodedHead = encodeURIComponent(config.sourceBranch);
    return `https://github.com/${encodedOwner}/${encodedName}/pull/new/${encodedBase}...${encodedHead}`;
  }

  buildGitPushSpec(config: BuildGitPushSpecConfig): GitPushSpec {
    const force = config.force ?? false;
    const remoteUrl = `https://x-access-token:${config.auth.token}@github.com/${config.owner}/${config.name}.git`;
    const redactedRemoteUrl = `https://x-access-token:<redacted>@github.com/${config.owner}/${config.name}.git`;

    return {
      remoteUrl,
      redactedRemoteUrl,
      refspec: `${config.sourceRef}:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      repoOwner: config.owner,
      repoName: config.name,
      force,
    };
  }

  /**
   * Add labels to a pull request.
   * This is a best-effort operation - failures are logged but don't fail the PR creation.
   */
  private async addLabels(
    accessToken: string,
    owner: string,
    repo: string,
    prNumber: number,
    labels: string[]
  ): Promise<void> {
    try {
      const response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/labels`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": this.userAgent,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ labels }),
        }
      );

      if (!response.ok) {
        // Log but don't throw - labels are best-effort
        console.warn(`Failed to add labels to PR #${prNumber}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Failed to add labels to PR #${prNumber}:`, error);
    }
  }

  /**
   * Request reviewers for a pull request.
   * This is a best-effort operation - failures are logged but don't fail the PR creation.
   */
  private async requestReviewers(
    accessToken: string,
    owner: string,
    repo: string,
    prNumber: number,
    reviewers: string[]
  ): Promise<void> {
    try {
      const response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": this.userAgent,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reviewers }),
        }
      );

      if (!response.ok) {
        // Log but don't throw - reviewers are best-effort
        console.warn(`Failed to request reviewers for PR #${prNumber}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Failed to request reviewers for PR #${prNumber}:`, error);
    }
  }
}

/**
 * Create a GitHub source control provider.
 *
 * @param config - Provider configuration (optional)
 * @returns GitHub source control provider instance
 */
export function createGitHubProvider(config: GitHubProviderConfig = {}): SourceControlProvider {
  return new GitHubSourceControlProvider(config);
}
