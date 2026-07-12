/**
 * GitHub source control provider implementation.
 *
 * Implements the SourceControlProvider interface for GitHub,
 * wrapping existing GitHub API functions.
 */

import { z } from "zod";
import { toDisplayStatus, type InstallationRepository } from "@open-inspect/shared";
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
  updated_at: z.string().optional(),
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

/** Parse GitHub's ISO-8601 updated_at into epoch ms; undefined when absent/invalid. */
function parseProviderUpdatedAt(updatedAt: string | undefined): number | undefined {
  if (!updatedAt) return undefined;
  const parsed = Date.parse(updatedAt);
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

    const data = (await response.json()) as {
      id: number;
      name: string;
      full_name: string;
      default_branch: string;
      private: boolean;
      owner: { login: string };
    };

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
      state: toDisplayStatus(status),
      lifecycleState: status.lifecycleState,
      isDraft: status.isDraft,
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
      headSha: data.head.sha,
      repositoryExternalId:
        repositoryExternalId !== undefined ? String(repositoryExternalId) : undefined,
      providerUpdatedAt: parseProviderUpdatedAt(data.updated_at),
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
      providerUpdatedAt: parseProviderUpdatedAt(data.updated_at),
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
