import type { GitHubPort, RepositoryInfo } from "../ports/github-port";
import {
  exchangeCodeForToken,
  refreshAccessToken,
  getGitHubUser,
  type GitHubOAuthConfig,
} from "./github";
import {
  generateInstallationToken,
  listInstallationRepositories,
  type GitHubAppConfig,
} from "./github-app";
import {
  createPullRequest,
  getPullRequestByHead,
  getRepository,
  type CreatePRRequest,
  type CreatePRResponse,
} from "./pr";
import type { GitHubTokenResponse, GitHubUser } from "../types";
import type { InstallationRepository } from "@open-inspect/shared";

export class GitHubClient implements GitHubPort {
  constructor(
    private appConfig: GitHubAppConfig,
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
    const config = installationId ? { ...this.appConfig, installationId } : this.appConfig;
    return generateInstallationToken(config);
  }

  async createPullRequest(request: CreatePRRequest): Promise<CreatePRResponse> {
    // Encryption key is needed by createPullRequest to decrypt the user's token
    // The existing function takes the request and the key
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
    return listInstallationRepositories(this.appConfig);
  }
}
