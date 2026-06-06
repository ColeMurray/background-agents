import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepoImageBuildProfileResolver } from "./build-profile-resolver";
import {
  resolveSandboxSettings,
  resolveSandboxSettingsForRepos,
} from "../session/integration-settings-resolution";

vi.mock("../session/integration-settings-resolution", () => ({
  resolveSandboxSettings: vi.fn(),
  resolveSandboxSettingsForRepos: vi.fn(),
}));

describe("RepoImageBuildProfileResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a repo image profile without returning sandbox settings", async () => {
    vi.mocked(resolveSandboxSettings).mockResolvedValueOnce({ dockerEnabled: true });

    const resolver = new RepoImageBuildProfileResolver({} as D1Database);
    const profile = await resolver.resolve({ repoOwner: "acme", repoName: "app" });

    expect(profile).toEqual({
      repo: { repoOwner: "acme", repoName: "app" },
      imageProfile: "docker",
    });
    expect(profile).not.toHaveProperty("sandboxSettings");
  });

  it("resolves many repo image profiles without returning sandbox settings", async () => {
    vi.mocked(resolveSandboxSettingsForRepos).mockResolvedValueOnce([
      { dockerEnabled: false },
      { dockerEnabled: true },
    ]);

    const resolver = new RepoImageBuildProfileResolver({} as D1Database);
    const profiles = await resolver.resolveMany([
      { repoOwner: "acme", repoName: "app" },
      { repoOwner: "acme", repoName: "api" },
    ]);

    expect(profiles).toEqual([
      { repo: { repoOwner: "acme", repoName: "app" }, imageProfile: "default" },
      { repo: { repoOwner: "acme", repoName: "api" }, imageProfile: "docker" },
    ]);
    expect(profiles[0]).not.toHaveProperty("sandboxSettings");
    expect(profiles[1]).not.toHaveProperty("sandboxSettings");
  });
});
