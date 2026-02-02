import type { GitHubPort } from "../ports/github-port";
import type { RepositoryInfo, CreatePRRequest, CreatePRResponse } from "../ports/types";
import {
  exchangeCodeForToken,
  refreshAccessToken,
  getGitHubUser,
  type GitHubOAuthConfig,
} from "../auth/github";
import {
  generateInstallationToken,
  listInstallationRepositories,
  type GitHubAppConfig,
} from "../auth/github-app";
import { createPullRequest, getPullRequestByHead, getRepository } from "../auth/pr";
import type { GitHubTokenResponse, GitHubUser } from "../types";
import type { InstallationRepository } from "@open-inspect/shared";

export class GitHubAdapter implements GitHubPort {
  constructor(
    private appConfig: GitHubAppConfig | null,
    private oauthConfig: GitHubOAuthConfig
  ) {}

  async exchangeCodeForToken(code: string): Promise<GitHubTokenResponse> {
    return exchangeCodeForToken(code, this.oauthConfig);
  }

  async refreshAccessToken(refreshToken: string): Promise<GitHubTokenResponse> {
    return refreshAccessToken(refreshToken, this.oauthConfig);
  }

  async getCurrentUser(accessToken: string): Promise<GitHubUser> {
    return getGitHubUser(accessToken);
  }

  async generateInstallationToken(installationId?: string): Promise<string> {
    if (!this.appConfig) {
      throw new Error("GitHub App config not configured");
    }
    const config = installationId ? { ...this.appConfig, installationId } : this.appConfig;
    return generateInstallationToken(config);
  }

  async createPullRequest(request: CreatePRRequest): Promise<CreatePRResponse> {
    return createPullRequest(request, this.oauthConfig.encryptionKey);
  }

  async getPullRequestByHead(
    accessToken: string,
    owner: string,
    repo: string,
    head: string
  ): Promise<CreatePRResponse | null> {
    return getPullRequestByHead(accessToken, owner, repo, head);
  }

  async getRepository(accessToken: string, owner: string, repo: string): Promise<RepositoryInfo> {
    return getRepository(accessToken, owner, repo);
  }

  async listInstallationRepositories(): Promise<InstallationRepository[]> {
    if (!this.appConfig) {
      throw new Error("GitHub App config not configured");
    }
    return listInstallationRepositories(this.appConfig);
  }
}
