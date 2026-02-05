/**
 * GitHub source control provider implementation.
 *
 * Implements the SourceControlProvider interface for GitHub,
 * wrapping existing GitHub API functions.
 */

import type {
  SourceControlProvider,
  SourceControlProviderCapabilities,
  SourceControlAuthContext,
  GetRepositoryConfig,
  RepositoryInfo,
  CreatePullRequestConfig,
  CreatePullRequestResult,
  GitPushAuthContext,
  SourceControlTokenManager,
} from "../types";
import { SourceControlProviderError } from "../errors";
import { generateInstallationToken } from "../../auth/github-app";
import type { GitHubProviderConfig } from "./types";
import { USER_AGENT, GITHUB_API_BASE } from "./constants";

/**
 * GitHub implementation of SourceControlProvider.
 */
export class GitHubSourceControlProvider implements SourceControlProvider {
  readonly name = "github";

  readonly capabilities: SourceControlProviderCapabilities = {
    supportsPullRequests: true,
    supportsDraftPullRequests: true,
    supportsReviewers: true,
    supportsLabels: true,
    supportsProtectedBranches: true,
    supportsAppAuth: true,
  };

  private readonly tokenManager: SourceControlTokenManager;
  private readonly appConfig?: GitHubProviderConfig["appConfig"];

  constructor(config: GitHubProviderConfig) {
    this.tokenManager = config.tokenManager;
    this.appConfig = config.appConfig;
  }

  /**
   * Get repository information from GitHub API.
   */
  async getRepository(
    auth: SourceControlAuthContext,
    config: GetRepositoryConfig
  ): Promise<RepositoryInfo> {
    const accessToken = await this.tokenManager.decrypt(auth.encryptedToken);

    const response = await fetch(`${GITHUB_API_BASE}/repos/${config.owner}/${config.name}`, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
      },
    });

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
    const accessToken = await this.tokenManager.decrypt(auth.encryptedToken);

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

    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${config.repository.owner}/${config.repository.name}/pulls`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${accessToken}`,
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
        accessToken,
        config.repository.owner,
        config.repository.name,
        data.number,
        config.labels
      );
    }

    // Request reviewers if requested
    if (config.reviewers && config.reviewers.length > 0) {
      await this.requestReviewers(
        accessToken,
        config.repository.owner,
        config.repository.name,
        data.number,
        config.reviewers
      );
    }

    return result;
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
      const token = await generateInstallationToken(this.appConfig);
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
      const response = await fetch(
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
      const response = await fetch(
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
 * @param config - Provider configuration
 * @returns GitHub source control provider instance
 */
export function createGitHubProvider(config: GitHubProviderConfig): SourceControlProvider {
  return new GitHubSourceControlProvider(config);
}
