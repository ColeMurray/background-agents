import type { GitHubTokenResponse, GitHubUser } from "../types";
import type { CreatePRRequest, CreatePRResponse, RepositoryInfo } from "./types";
import type { InstallationRepository } from "@open-inspect/shared";

export interface GitHubPort {
  // OAuth
  exchangeCodeForToken(code: string): Promise<GitHubTokenResponse>;
  refreshAccessToken(refreshToken: string): Promise<GitHubTokenResponse>;
  getCurrentUser(accessToken: string): Promise<GitHubUser>;

  // App authentication
  generateInstallationToken(installationId?: string): Promise<string>;

  // Pull requests
  createPullRequest(request: CreatePRRequest): Promise<CreatePRResponse>;
  getPullRequestByHead(
    accessToken: string,
    owner: string,
    repo: string,
    head: string
  ): Promise<CreatePRResponse | null>;

  // Repositories
  getRepository(accessToken: string, owner: string, repo: string): Promise<RepositoryInfo>;
  listInstallationRepositories(): Promise<InstallationRepository[]>;
}
