import {
  normalizeSandboxRuntimeSettings,
  resolveSandboxImageProfile,
  type SandboxImageProfile,
  type SandboxRuntimeSettings,
} from "@open-inspect/shared";

import {
  resolveSandboxSettings,
  resolveSandboxSettingsForRepos,
} from "../session/integration-settings-resolution";

export interface RepoImageBuildRepo {
  repoOwner: string;
  repoName: string;
}

export interface RepoImageBuildPlan {
  repo: RepoImageBuildRepo;
  sandboxSettings: SandboxRuntimeSettings;
  imageProfile: SandboxImageProfile;
}

export class RepoImageBuildPlanner {
  constructor(private readonly db: D1Database) {}

  async plan(repo: RepoImageBuildRepo): Promise<RepoImageBuildPlan> {
    const sandboxSettings = normalizeSandboxRuntimeSettings(
      await resolveSandboxSettings(this.db, repo.repoOwner, repo.repoName)
    );
    return {
      repo,
      sandboxSettings,
      imageProfile: resolveSandboxImageProfile(sandboxSettings),
    };
  }

  async planMany(repos: RepoImageBuildRepo[]): Promise<RepoImageBuildPlan[]> {
    const sandboxSettings = (await resolveSandboxSettingsForRepos(this.db, repos)).map((settings) =>
      normalizeSandboxRuntimeSettings(settings)
    );
    return repos.map((repo, index) => ({
      repo,
      sandboxSettings: sandboxSettings[index],
      imageProfile: resolveSandboxImageProfile(sandboxSettings[index]),
    }));
  }
}
