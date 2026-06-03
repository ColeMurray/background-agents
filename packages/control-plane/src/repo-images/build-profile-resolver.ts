import { resolveSandboxImageProfile, type SandboxImageProfile } from "@open-inspect/shared";

import {
  resolveSandboxSettings,
  resolveSandboxSettingsForRepos,
} from "../session/integration-settings-resolution";

export interface RepoImageBuildRepo {
  repoOwner: string;
  repoName: string;
}

export interface RepoImageBuildProfile {
  repo: RepoImageBuildRepo;
  imageProfile: SandboxImageProfile;
}

/**
 * Resolves the repo-image build profile from repository sandbox settings.
 *
 * Repo image builds only need the derived compatibility key (`imageProfile`). Runtime sandbox
 * settings stay in the control plane and are not forwarded to Modal's async builder. Centralizing
 * this lookup keeps manual triggers and scheduler responses aligned without making route handlers
 * understand Docker settings.
 */
export class RepoImageBuildProfileResolver {
  constructor(private readonly db: D1Database) {}

  async resolve(repo: RepoImageBuildRepo): Promise<RepoImageBuildProfile> {
    const sandboxSettings = await resolveSandboxSettings(this.db, repo.repoOwner, repo.repoName);
    return {
      repo,
      imageProfile: resolveSandboxImageProfile(sandboxSettings),
    };
  }

  async resolveMany(repos: RepoImageBuildRepo[]): Promise<RepoImageBuildProfile[]> {
    const sandboxSettings = await resolveSandboxSettingsForRepos(this.db, repos);
    return repos.map((repo, index) => ({
      repo,
      imageProfile: resolveSandboxImageProfile(sandboxSettings[index]),
    }));
  }
}
