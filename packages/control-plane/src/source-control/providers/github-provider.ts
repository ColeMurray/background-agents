/**
 * GitHub source control provider implementation.
 *
 * Implements the SourceControlProvider interface for GitHub,
 * wrapping existing GitHub API functions.
 */

import type { InstallationRepository } from "@open-inspect/shared";
import type {
  SourceControlProvider,
  SourceControlAuthContext,
  GetRepositoryConfig,
  RepositoryAccessResult,
  RepositoryInfo,
  CreatePullRequestConfig,
  CreatePullRequestResult,
  BuildManualPullRequestUrlConfig,
  BuildGitPushSpecConfig,
  GitPushSpec,
  GitPushAuthContext,
} from "../types";
import { SourceControlProviderError } from "../errors";
import {
  getCachedInstallationToken,
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

/**
 * GitHub implementation of SourceControlProvider.
 */
export class GitHubSourceControlProvider implements SourceControlProvider {
  readonly name = "github";

  private readonly appConfig?: GitHubProviderConfig["appConfig"];
  private readonly allAppConfigs: NonNullable<GitHubProviderConfig["appConfig"]>[];
  private readonly kvCache?: KVNamespace;

  constructor(config: GitHubProviderConfig = {}) {
    this.appConfig = config.appConfig;
    const filtered = config.allAppConfigs?.filter(Boolean);
    this.allAppConfigs =
      filtered && filtered.length > 0 ? filtered : config.appConfig ? [config.appConfig] : [];
    this.kvCache = config.kvCache;
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
          "User-Agent": USER_AGENT,
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
          "User-Agent": USER_AGENT,
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

    const data = (await response.json()) as {
      number: number;
      html_url: string;
      url: string;
      state: string;
      draft: boolean;
      merged: boolean;
      head: { ref: string };
      base: { ref: string };
    };

    // Map GitHub state to our state type
    // GitHub uses state: "closed" + merged: true for merged PRs
    let state: CreatePullRequestResult["state"];
    if (data.draft) {
      state = "draft";
    } else if (data.merged) {
      state = "merged";
    } else if (data.state === "open") {
      state = "open";
    } else if (data.state === "closed") {
      state = "closed";
    } else {
      state = "open"; // Default to open for unknown states
    }

    const result: CreatePullRequestResult = {
      id: data.number,
      webUrl: data.html_url,
      apiUrl: data.url,
      state,
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
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
   * Check whether a repository is accessible to the GitHub App installation.
   */
  async checkRepositoryAccess(config: GetRepositoryConfig): Promise<RepositoryAccessResult | null> {
    if (this.allAppConfigs.length === 0) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot check repository access",
        "permanent"
      );
    }

    // Try each installation until one has access
    let lastError: unknown;

    for (const appConfig of this.allAppConfigs) {
      try {
        const repo = await getInstallationRepository(
          appConfig,
          config.owner,
          config.name,
          this.kvCache ? { REPOS_CACHE: this.kvCache } : undefined
        );
        if (repo) {
          return {
            repoId: repo.id,
            repoOwner: config.owner.toLowerCase(),
            repoName: config.name.toLowerCase(),
            defaultBranch: repo.defaultBranch,
          };
        }
      } catch (error) {
        // Log and continue to next installation
        console.warn(
          `checkRepositoryAccess failed for installation ${appConfig.installationId}: ${error instanceof Error ? error.message : String(error)}`
        );
        lastError = error;
      }
    }

    // If any installation errored and none found the repo, propagate the error
    // rather than silently returning null (which the caller treats as "not found").
    // The repo might live in the installation that failed.
    if (lastError) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to check repository access across all installations: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        lastError,
        extractHttpStatus(lastError)
      );
    }

    return null;
  }

  /**
   * List all repositories accessible to the GitHub App installation.
   */
  async listRepositories(): Promise<InstallationRepository[]> {
    if (this.allAppConfigs.length === 0) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot list repositories",
        "permanent"
      );
    }

    const seen = new Set<string>();
    const allRepos: InstallationRepository[] = [];
    let lastError: unknown;
    let successCount = 0;

    const results = await Promise.allSettled(
      this.allAppConfigs.map((appConfig) =>
        listInstallationRepositories(
          appConfig,
          this.kvCache ? { REPOS_CACHE: this.kvCache } : undefined
        )
      )
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        successCount++;
        for (const repo of result.value.repos) {
          const key = `${repo.owner}/${repo.name}`.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            allRepos.push(repo);
          }
        }
      } else {
        const installationId = this.allAppConfigs[i].installationId;
        console.warn(
          `Failed to list repos for installation ${installationId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
        lastError = result.reason;
      }
    }

    // If no installation succeeded, surface the error with proper classification
    if (successCount === 0 && lastError) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to list repositories: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        lastError,
        extractHttpStatus(lastError)
      );
    }

    return allRepos;
  }

  /**
   * List branches for a repository.
   */
  async listBranches(config: GetRepositoryConfig): Promise<{ name: string }[]> {
    if (this.allAppConfigs.length === 0) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot list branches",
        "permanent"
      );
    }

    let lastError: unknown;
    for (const appConfig of this.allAppConfigs) {
      try {
        return await listRepositoryBranches(
          appConfig,
          config.owner,
          config.name,
          this.kvCache ? { REPOS_CACHE: this.kvCache } : undefined
        );
      } catch (error) {
        console.warn(
          `listBranches failed for installation ${appConfig.installationId}: ${error instanceof Error ? error.message : String(error)}`
        );
        lastError = error;
      }
    }

    throw SourceControlProviderError.fromFetchError(
      `Failed to list branches across all installations: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError,
      extractHttpStatus(lastError)
    );
  }

  /**
   * Generate authentication for git push operations using GitHub App.
   */
  async generatePushAuth(repoOwner?: string, repoName?: string): Promise<GitPushAuthContext> {
    if (this.allAppConfigs.length === 0) {
      throw new SourceControlProviderError(
        "GitHub App not configured - cannot generate push auth",
        "permanent"
      );
    }

    // If we know the repo, find the owning installation
    if (repoOwner && repoName) {
      for (const appConfig of this.allAppConfigs) {
        let repo: InstallationRepository | null;
        try {
          repo = await getInstallationRepository(
            appConfig,
            repoOwner,
            repoName,
            this.kvCache ? { REPOS_CACHE: this.kvCache } : undefined
          );
        } catch {
          // Repo lookup failed for this installation — try next
          continue;
        }
        if (repo) {
          // Found the owning installation — token errors must propagate
          const token = await getCachedInstallationToken(appConfig);
          return { authType: "app", token };
        }
      }
      // No installation claims this repo
      console.warn(
        `generatePushAuth: repo ${repoOwner}/${repoName} not found in any installation, falling back to primary`
      );
    }

    // Fallback: use primary installation (no repo context or repo not found)
    try {
      const token = await getCachedInstallationToken(this.allAppConfigs[0]);
      return { authType: "app", token };
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub App token: ${error instanceof Error ? error.message : String(error)}`,
        error
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
            "User-Agent": USER_AGENT,
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
            "User-Agent": USER_AGENT,
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
