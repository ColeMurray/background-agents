import { describe, expect, it, vi } from "vitest";
import { GitHubSourceControlProvider } from "./github-provider";
import { SourceControlProviderError } from "../errors";

// Mock the upstream GitHub App auth functions
vi.mock("../../auth/github-app", () => ({
  getCachedInstallationToken: vi.fn(),
  getInstallationRepository: vi.fn(),
  listInstallationRepositories: vi.fn(),
  fetchWithTimeout: vi.fn(),
}));

import {
  getInstallationRepository,
  listInstallationRepositories,
  getCachedInstallationToken,
} from "../../auth/github-app";

const mockGetInstallationRepository = vi.mocked(getInstallationRepository);
const mockGetCachedInstallationToken = vi.mocked(getCachedInstallationToken);
const mockListInstallationRepositories = vi.mocked(listInstallationRepositories);

const fakeAppConfig = {
  appId: "123",
  privateKey: "fake-key",
  installationId: "456",
};

describe("GitHubSourceControlProvider", () => {
  describe("checkRepositoryAccess", () => {
    it("throws permanent error with no httpStatus when appConfig is missing", async () => {
      const provider = new GitHubSourceControlProvider();
      const err = await provider
        .checkRepositoryAccess({ owner: "acme", name: "web" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("permanent");
      expect((err as SourceControlProviderError).httpStatus).toBeUndefined();
    });

    it("classifies upstream 429 error as transient", async () => {
      const httpError = Object.assign(new Error("rate limited: 429"), { status: 429 });
      mockGetInstallationRepository.mockRejectedValueOnce(httpError);

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const err = await provider
        .checkRepositoryAccess({ owner: "acme", name: "web" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("transient");
      expect((err as SourceControlProviderError).httpStatus).toBe(429);
    });

    it("classifies upstream 502 error as transient", async () => {
      const httpError = Object.assign(new Error("bad gateway: 502"), { status: 502 });
      mockGetInstallationRepository.mockRejectedValueOnce(httpError);

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const err = await provider
        .checkRepositoryAccess({ owner: "acme", name: "web" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("transient");
      expect((err as SourceControlProviderError).httpStatus).toBe(502);
    });

    it("classifies upstream 401 error as permanent with httpStatus", async () => {
      const httpError = Object.assign(new Error("unauthorized: 401"), { status: 401 });
      mockGetInstallationRepository.mockRejectedValueOnce(httpError);

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const err = await provider
        .checkRepositoryAccess({ owner: "acme", name: "web" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("permanent");
      expect((err as SourceControlProviderError).httpStatus).toBe(401);
    });
  });

  describe("listRepositories", () => {
    it("throws permanent error with no httpStatus when appConfig is missing", async () => {
      const provider = new GitHubSourceControlProvider();
      const err = await provider.listRepositories().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("permanent");
      expect((err as SourceControlProviderError).httpStatus).toBeUndefined();
    });

    it("classifies upstream 429 error as transient", async () => {
      const httpError = Object.assign(new Error("rate limited: 429"), { status: 429 });
      mockListInstallationRepositories.mockRejectedValueOnce(httpError);

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const err = await provider.listRepositories().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("transient");
      expect((err as SourceControlProviderError).httpStatus).toBe(429);
    });

    it("classifies upstream 502 error as transient", async () => {
      const httpError = Object.assign(new Error("bad gateway: 502"), { status: 502 });
      mockListInstallationRepositories.mockRejectedValueOnce(httpError);

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const err = await provider.listRepositories().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("transient");
      expect((err as SourceControlProviderError).httpStatus).toBe(502);
    });

    it("classifies upstream 401 error as permanent with httpStatus", async () => {
      const httpError = Object.assign(new Error("unauthorized: 401"), { status: 401 });
      mockListInstallationRepositories.mockRejectedValueOnce(httpError);

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const err = await provider.listRepositories().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("permanent");
      expect((err as SourceControlProviderError).httpStatus).toBe(401);
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

  describe("multi-installation support", () => {
    const configA = { appId: "123", privateKey: "key", installationId: "aaa" };
    const configB = { appId: "123", privateKey: "key", installationId: "bbb" };

    it("falls back to appConfig when allAppConfigs is empty array", async () => {
      const provider = new GitHubSourceControlProvider({
        appConfig: configA,
        allAppConfigs: [],
      });

      mockListInstallationRepositories.mockResolvedValueOnce({
        repos: [
          {
            id: 1,
            owner: "org",
            name: "repo",
            defaultBranch: "main",
            private: false,
            fullName: "org/repo",
            description: null,
          },
        ],
        timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 0 },
      });

      const repos = await provider.listRepositories();
      expect(repos).toHaveLength(1);
    });

    describe("listRepositories", () => {
      it("merges repos from multiple installations", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockListInstallationRepositories
          .mockResolvedValueOnce({
            repos: [
              {
                id: 1,
                owner: "org",
                name: "repo-a",
                defaultBranch: "main",
                private: false,
                fullName: "org/repo-a",
                description: null,
              },
            ],
            timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 0 },
          })
          .mockResolvedValueOnce({
            repos: [
              {
                id: 2,
                owner: "user",
                name: "repo-b",
                defaultBranch: "main",
                private: false,
                fullName: "user/repo-b",
                description: null,
              },
            ],
            timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 0 },
          });

        const repos = await provider.listRepositories();
        expect(repos).toHaveLength(2);
        expect(repos.map((r) => `${r.owner}/${r.name}`)).toEqual(["org/repo-a", "user/repo-b"]);
      });

      it("deduplicates repos case-insensitively", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockListInstallationRepositories
          .mockResolvedValueOnce({
            repos: [
              {
                id: 1,
                owner: "Org",
                name: "Shared",
                defaultBranch: "main",
                private: false,
                fullName: "Org/Shared",
                description: null,
              },
            ],
            timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 0 },
          })
          .mockResolvedValueOnce({
            repos: [
              {
                id: 1,
                owner: "org",
                name: "shared",
                defaultBranch: "main",
                private: false,
                fullName: "org/shared",
                description: null,
              },
            ],
            timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 0 },
          });

        const repos = await provider.listRepositories();
        expect(repos).toHaveLength(1);
      });

      it("deduplicates repos appearing in multiple installations", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        const sharedRepo = {
          id: 1,
          owner: "org",
          name: "shared",
          defaultBranch: "main",
          private: false,
          fullName: "org/shared",
          description: null,
        };
        mockListInstallationRepositories
          .mockResolvedValueOnce({
            repos: [sharedRepo],
            timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 0 },
          })
          .mockResolvedValueOnce({
            repos: [sharedRepo],
            timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 0 },
          });

        const repos = await provider.listRepositories();
        expect(repos).toHaveLength(1);
      });

      it("continues when one installation fails", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockListInstallationRepositories
          .mockRejectedValueOnce(new Error("token expired"))
          .mockResolvedValueOnce({
            repos: [
              {
                id: 2,
                owner: "user",
                name: "repo-b",
                defaultBranch: "main",
                private: false,
                fullName: "user/repo-b",
                description: null,
              },
            ],
            timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 0 },
          });

        const repos = await provider.listRepositories();
        expect(repos).toHaveLength(1);
        expect(repos[0].name).toBe("repo-b");
      });
    });

    describe("checkRepositoryAccess", () => {
      it("finds repo in second installation when not in first", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetInstallationRepository.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 2,
          owner: "user",
          name: "repo",
          defaultBranch: "main",
          private: false,
          fullName: "user/repo",
          description: null,
        });

        const result = await provider.checkRepositoryAccess({ owner: "user", name: "repo" });
        expect(result).not.toBeNull();
        expect(result?.repoOwner).toBe("user");
      });

      it("returns null when repo not found in any installation", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetInstallationRepository.mockResolvedValue(null);

        const result = await provider.checkRepositoryAccess({ owner: "user", name: "nope" });
        expect(result).toBeNull();
      });

      it("throws when first returns null and second throws", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetInstallationRepository
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(new Error("network timeout"));

        await expect(
          provider.checkRepositoryAccess({ owner: "user", name: "repo" })
        ).rejects.toThrow("Failed to check repository access across all installations");
      });

      it("throws when first throws and second returns null", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetInstallationRepository
          .mockRejectedValueOnce(new Error("bad token"))
          .mockResolvedValueOnce(null);

        await expect(
          provider.checkRepositoryAccess({ owner: "user", name: "repo" })
        ).rejects.toThrow("Failed to check repository access across all installations");
      });

      it("throws when all installations fail with errors", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetInstallationRepository.mockRejectedValue(new Error("API down"));

        await expect(
          provider.checkRepositoryAccess({ owner: "user", name: "repo" })
        ).rejects.toThrow("Failed to check repository access across all installations");
      });
    });

    describe("generatePushAuth", () => {
      it("uses owning installation token when repo is found", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetInstallationRepository.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 1,
          owner: "user",
          name: "repo",
          defaultBranch: "main",
          private: false,
          fullName: "user/repo",
          description: null,
        });
        mockGetCachedInstallationToken.mockResolvedValueOnce("token-from-bbb");

        const auth = await provider.generatePushAuth("user", "repo");
        expect(auth.token).toBe("token-from-bbb");
        // Token was requested for configB (the one that found the repo)
        expect(mockGetCachedInstallationToken).toHaveBeenCalledWith(configB);
      });

      it("propagates token error when owning installation is found", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetInstallationRepository.mockResolvedValueOnce({
          id: 1,
          owner: "user",
          name: "repo",
          defaultBranch: "main",
          private: false,
          fullName: "user/repo",
          description: null,
        });
        mockGetCachedInstallationToken.mockRejectedValueOnce(new Error("token fetch failed"));

        await expect(provider.generatePushAuth("user", "repo")).rejects.toThrow(
          "token fetch failed"
        );
      });

      it("falls back to primary when no installation claims the repo", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetInstallationRepository.mockResolvedValue(null);
        mockGetCachedInstallationToken.mockResolvedValueOnce("token-from-aaa");

        const auth = await provider.generatePushAuth("user", "unknown-repo");
        expect(auth.token).toBe("token-from-aaa");
        expect(mockGetCachedInstallationToken).toHaveBeenCalledWith(configA);
      });

      it("falls back to primary when no repo context provided", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetCachedInstallationToken.mockResolvedValueOnce("token-primary");

        const auth = await provider.generatePushAuth();
        expect(auth.token).toBe("token-primary");
      });

      it("skips errored installations during repo lookup", async () => {
        const provider = new GitHubSourceControlProvider({
          appConfig: configA,
          allAppConfigs: [configA, configB],
        });

        mockGetInstallationRepository
          .mockRejectedValueOnce(new Error("bad token"))
          .mockResolvedValueOnce({
            id: 1,
            owner: "user",
            name: "repo",
            defaultBranch: "main",
            private: false,
            fullName: "user/repo",
            description: null,
          });
        mockGetCachedInstallationToken.mockResolvedValueOnce("token-from-bbb");

        const auth = await provider.generatePushAuth("user", "repo");
        expect(auth.token).toBe("token-from-bbb");
      });
    });
  });
});
