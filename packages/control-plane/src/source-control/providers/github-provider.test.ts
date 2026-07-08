import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubSourceControlProvider } from "./github-provider";
import { SourceControlProviderError } from "../errors";

// Mock the upstream GitHub App auth functions
vi.mock("../../auth/github-app", () => ({
  getCachedInstallationToken: vi.fn(),
  getCachedInstallationTokenWithExpiry: vi.fn(),
  getInstallationRepository: vi.fn(),
  listInstallationRepositories: vi.fn(),
  fetchWithTimeout: vi.fn(),
}));

import {
  getCachedInstallationTokenWithExpiry,
  getInstallationRepository,
  listInstallationRepositories,
} from "../../auth/github-app";

const mockGetInstallationRepository = vi.mocked(getInstallationRepository);
const mockListInstallationRepositories = vi.mocked(listInstallationRepositories);
const mockGetCachedInstallationTokenWithExpiry = vi.mocked(getCachedInstallationTokenWithExpiry);

const fakeAppConfig = {
  appId: "123",
  privateKey: "fake-key",
  installationId: "456",
};

describe("GitHubSourceControlProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

    it("returns null for archived repositories", async () => {
      mockGetInstallationRepository.mockResolvedValueOnce({
        id: 1,
        owner: "acme",
        name: "web",
        fullName: "acme/web",
        description: null,
        private: true,
        archived: true,
        defaultBranch: "main",
      });

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const result = await provider.checkRepositoryAccess({ owner: "acme", name: "web" });

      expect(result).toBeNull();
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

    it("excludes archived repositories", async () => {
      mockListInstallationRepositories.mockResolvedValueOnce({
        repos: [
          {
            id: 1,
            owner: "acme",
            name: "active",
            fullName: "acme/active",
            description: null,
            private: true,
            archived: false,
            defaultBranch: "main",
          },
          {
            id: 2,
            owner: "acme",
            name: "archived",
            fullName: "acme/archived",
            description: null,
            private: true,
            archived: true,
            defaultBranch: "main",
          },
        ],
        timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 2 },
      });

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const repos = await provider.listRepositories();

      expect(repos.map((repo) => repo.fullName)).toEqual(["acme/active"]);
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
      repoOwner: "acme",
      repoName: "web",
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

  describe("userAgent threading", () => {
    it("forwards configured userAgent to listInstallationRepositories", async () => {
      mockListInstallationRepositories.mockResolvedValueOnce({
        repos: [],
        timing: { tokenGenerationMs: 0, pages: [], totalPages: 0, totalRepos: 0 },
      });

      const provider = new GitHubSourceControlProvider({
        appConfig: fakeAppConfig,
        userAgent: "Acme Bot",
      });
      await provider.listRepositories();

      expect(mockListInstallationRepositories).toHaveBeenCalledWith(
        fakeAppConfig,
        expect.objectContaining({ userAgent: "Acme Bot" })
      );
    });

    it("forwards configured userAgent to getInstallationRepository", async () => {
      mockGetInstallationRepository.mockResolvedValueOnce(null);

      const provider = new GitHubSourceControlProvider({
        appConfig: fakeAppConfig,
        userAgent: "Acme Bot",
      });
      await provider.checkRepositoryAccess({ owner: "acme", name: "web" });

      expect(mockGetInstallationRepository).toHaveBeenCalledWith(
        fakeAppConfig,
        "acme",
        "web",
        expect.objectContaining({ userAgent: "Acme Bot" })
      );
    });

    it("falls back to the default User-Agent when none is configured", async () => {
      mockGetInstallationRepository.mockResolvedValueOnce(null);

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      await provider.checkRepositoryAccess({ owner: "acme", name: "web" });

      expect(mockGetInstallationRepository).toHaveBeenCalledWith(
        fakeAppConfig,
        "acme",
        "web",
        expect.objectContaining({ userAgent: "Open-Inspect" })
      );
    });
  });

  describe("generateCredentialHelperAuth", () => {
    it("throws a permanent error when the App is not configured", async () => {
      const provider = new GitHubSourceControlProvider();
      const err = await provider.generateCredentialHelperAuth().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("permanent");
      expect((err as SourceControlProviderError).message).toMatch(/not configured/i);
    });

    it("forwards a fresh installation token with its expiry and x-access-token username", async () => {
      const expiresAtEpochMs = Date.now() + 60 * 60 * 1000;
      mockGetCachedInstallationTokenWithExpiry.mockResolvedValueOnce({
        token: "ghs_fresh",
        expiresAtEpochMs,
      });

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const auth = await provider.generateCredentialHelperAuth();

      expect(auth).toEqual({
        username: "x-access-token",
        password: "ghs_fresh",
        expiresAtEpochMs,
      });
      expect(mockGetCachedInstallationTokenWithExpiry).toHaveBeenCalledWith(
        fakeAppConfig,
        expect.objectContaining({ userAgent: expect.any(String) })
      );
    });

    it("wraps upstream errors as SourceControlProviderError", async () => {
      mockGetCachedInstallationTokenWithExpiry.mockRejectedValueOnce(new Error("GitHub 500"));

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const err = await provider.generateCredentialHelperAuth().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).message).toContain("GitHub 500");
    });

    it("classifies an upstream 5xx (with .status) as transient", async () => {
      const httpError = Object.assign(new Error("Failed to get installation token: 500 down"), {
        status: 500,
      });
      mockGetCachedInstallationTokenWithExpiry.mockRejectedValueOnce(httpError);

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const err = await provider.generateCredentialHelperAuth().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      // Transient → the service maps this to 502, not 500.
      expect((err as SourceControlProviderError).errorType).toBe("transient");
      expect((err as SourceControlProviderError).httpStatus).toBe(500);
    });
  });
});
