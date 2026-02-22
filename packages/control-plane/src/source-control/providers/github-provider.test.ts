import { describe, expect, it } from "vitest";
import { GitHubSourceControlProvider } from "./github-provider";
import { SourceControlProviderError } from "../errors";

describe("GitHubSourceControlProvider", () => {
  describe("checkRepositoryAccess", () => {
    it("throws permanent error when appConfig is missing", async () => {
      const provider = new GitHubSourceControlProvider();
      await expect(provider.checkRepositoryAccess({ owner: "acme", name: "web" })).rejects.toThrow(
        SourceControlProviderError
      );

      try {
        await provider.checkRepositoryAccess({ owner: "acme", name: "web" });
      } catch (e) {
        expect(e).toBeInstanceOf(SourceControlProviderError);
        expect((e as SourceControlProviderError).errorType).toBe("permanent");
      }
    });
  });

  describe("listRepositories", () => {
    it("throws permanent error when appConfig is missing", async () => {
      const provider = new GitHubSourceControlProvider();
      await expect(provider.listRepositories()).rejects.toThrow(SourceControlProviderError);

      try {
        await provider.listRepositories();
      } catch (e) {
        expect(e).toBeInstanceOf(SourceControlProviderError);
        expect((e as SourceControlProviderError).errorType).toBe("permanent");
      }
    });
  });

  it("builds manual pull request URL with encoded components", () => {
    const provider = new GitHubSourceControlProvider();
    const url = provider.buildManualPullRequestUrl({
      owner: "acme org",
      name: "web/app",
      sourceBranch: "feature/test branch",
      targetBranch: "main",
    });

    expect(url).toBe(
      "https://github.com/acme%20org/web%2Fapp/pull/new/main...feature%2Ftest%20branch"
    );
  });

  it("builds provider push spec for bridge execution", () => {
    const provider = new GitHubSourceControlProvider();
    const spec = provider.buildGitPushSpec({
      owner: "acme",
      name: "web",
      sourceRef: "HEAD",
      targetBranch: "feature/one",
      auth: {
        authType: "app",
        token: "token-123",
      },
      force: false,
    });

    expect(spec).toEqual({
      remoteUrl: "https://x-access-token:token-123@github.com/acme/web.git",
      redactedRemoteUrl: "https://x-access-token:<redacted>@github.com/acme/web.git",
      refspec: "HEAD:refs/heads/feature/one",
      targetBranch: "feature/one",
      force: false,
    });
  });

  it("defaults push spec to non-force push", () => {
    const provider = new GitHubSourceControlProvider();
    const spec = provider.buildGitPushSpec({
      owner: "acme",
      name: "web",
      sourceRef: "HEAD",
      targetBranch: "feature/two",
      auth: {
        authType: "app",
        token: "token-456",
      },
    });

    expect(spec.force).toBe(false);
  });
});
