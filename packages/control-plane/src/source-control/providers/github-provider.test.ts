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
  fetchWithTimeout,
  getCachedInstallationToken,
  getCachedInstallationTokenWithExpiry,
  getInstallationRepository,
  listInstallationRepositories,
} from "../../auth/github-app";

const mockGetInstallationRepository = vi.mocked(getInstallationRepository);
const mockListInstallationRepositories = vi.mocked(listInstallationRepositories);
const mockGetCachedInstallationTokenWithExpiry = vi.mocked(getCachedInstallationTokenWithExpiry);
const mockGetCachedInstallationToken = vi.mocked(getCachedInstallationToken);
const mockFetchWithTimeout = vi.mocked(fetchWithTimeout);

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const fakeAuth = { authType: "app" as const, token: "ghs_test" };
const fakeRepository = {
  owner: "acme",
  name: "web",
  fullName: "acme/web",
  defaultBranch: "main",
  isPrivate: true,
  providerRepoId: 1,
};

const fakeAppConfig = {
  appId: "123",
  privateKey: "fake-key",
  installationId: "456",
};

describe("GitHubSourceControlProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getBranchHead", () => {
    it("resolves a slash-containing branch and returns its full SHA", async () => {
      mockGetCachedInstallationToken.mockResolvedValue("installation-token");
      mockFetchWithTimeout.mockResolvedValue(
        new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 })
      );
      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

      await expect(
        provider.getBranchHead({ owner: "acme", name: "web", branch: "feature/test" })
      ).resolves.toBe("abc123");
      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining("heads/feature%2Ftest"),
        expect.any(Object)
      );
    });

    it("returns null only for a confirmed missing branch", async () => {
      mockGetCachedInstallationToken.mockResolvedValue("installation-token");
      mockFetchWithTimeout.mockResolvedValue(new Response("", { status: 404 }));
      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

      await expect(
        provider.getBranchHead({ owner: "acme", name: "web", branch: "missing" })
      ).resolves.toBeNull();
    });

    it("rejects malformed branch ref responses", async () => {
      mockGetCachedInstallationToken.mockResolvedValue("installation-token");
      mockFetchWithTimeout.mockResolvedValue(makeJsonResponse({ object: {} }));
      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

      const err = await provider
        .getBranchHead({ owner: "acme", name: "web", branch: "main" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).message).toBe(
        "Failed to resolve branch head: unexpected response shape (object.sha)"
      );
      expect((err as SourceControlProviderError).errorType).toBe("permanent");
    });
  });

  describe("getRepository", () => {
    it("maps GitHub repository metadata from a valid API response", async () => {
      mockFetchWithTimeout.mockResolvedValue(
        makeJsonResponse({
          id: 42,
          name: "web",
          full_name: "acme/web",
          default_branch: "main",
          private: true,
          owner: { login: "acme" },
        })
      );
      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

      await expect(
        provider.getRepository(
          { authType: "app", token: "installation-token" },
          { owner: "acme", name: "web" }
        )
      ).resolves.toEqual({
        owner: "acme",
        name: "web",
        fullName: "acme/web",
        defaultBranch: "main",
        isPrivate: true,
        providerRepoId: 42,
      });
    });

    it("rejects malformed repository metadata responses", async () => {
      mockFetchWithTimeout.mockResolvedValue(
        makeJsonResponse({
          id: 42,
          name: "web",
          full_name: "acme/web",
          default_branch: null,
          private: true,
          owner: { login: "acme" },
        })
      );
      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

      const err = await provider
        .getRepository(
          { authType: "app", token: "installation-token" },
          { owner: "acme", name: "web" }
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).message).toBe(
        "Failed to get repository: unexpected response shape (default_branch)"
      );
      expect((err as SourceControlProviderError).errorType).toBe("permanent");
    });

    it("rejects non-JSON repository responses", async () => {
      mockFetchWithTimeout.mockResolvedValue(
        new Response("<html>gateway</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
      );
      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

      const err = await provider
        .getRepository(
          { authType: "app", token: "installation-token" },
          { owner: "acme", name: "web" }
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).message).toBe(
        "Failed to get repository: response body is not JSON"
      );
      expect((err as SourceControlProviderError).errorType).toBe("permanent");
    });
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

    it("returns the provider's canonical repository identity", async () => {
      mockGetInstallationRepository.mockResolvedValueOnce({
        id: 1,
        owner: "New-Owner",
        name: "Renamed-Repo",
        fullName: "New-Owner/Renamed-Repo",
        description: null,
        private: true,
        archived: false,
        defaultBranch: "main",
      });
      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

      const result = await provider.checkRepositoryAccess({ owner: "old-owner", name: "old-repo" });

      expect(result).toMatchObject({ repoOwner: "new-owner", repoName: "renamed-repo" });
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

  describe("createPullRequest", () => {
    const prResponseBody = {
      number: 7,
      html_url: "https://github.com/acme/web/pull/7",
      url: "https://api.github.com/repos/acme/web/pulls/7",
      state: "open",
      draft: false,
      merged: false,
      head: { ref: "feature" },
      base: { ref: "main" },
    };

    it("creates a non-draft PR by default and does not send the draft flag", async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(makeResponse(prResponseBody));

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const result = await provider.createPullRequest(fakeAuth, {
        repository: fakeRepository,
        title: "Add feature",
        body: "Body",
        sourceBranch: "feature",
        targetBranch: "main",
      });

      expect(result.id).toBe(7);
      expect(result.lifecycleState).toBe("open");
      expect(result.isDraft).toBe(false);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
      const sentBody = JSON.parse(mockFetchWithTimeout.mock.calls[0][1]?.body as string);
      expect(sentBody.draft).toBeUndefined();
    });

    it("forwards the draft flag when draft is requested", async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(makeResponse({ ...prResponseBody, draft: true }));

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const result = await provider.createPullRequest(fakeAuth, {
        repository: fakeRepository,
        title: "Add feature",
        body: "Body",
        sourceBranch: "feature",
        targetBranch: "main",
        draft: true,
      });

      expect(result.isDraft).toBe(true);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
      const sentBody = JSON.parse(mockFetchWithTimeout.mock.calls[0][1]?.body as string);
      expect(sentBody.draft).toBe(true);
    });

    it("adds an existing label without trying to create it", async () => {
      mockFetchWithTimeout
        .mockResolvedValueOnce(makeResponse(prResponseBody, 201))
        .mockResolvedValueOnce(makeResponse({ name: "open inspect" }))
        .mockResolvedValueOnce(makeResponse([]));

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      await provider.createPullRequest(fakeAuth, {
        repository: fakeRepository,
        title: "Add feature",
        body: "Body",
        sourceBranch: "feature",
        targetBranch: "main",
        labels: ["open inspect"],
      });

      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
      expect(mockFetchWithTimeout.mock.calls[1][0]).toMatch(
        /\/repos\/acme\/web\/labels\/open%20inspect$/
      );
      expect(mockFetchWithTimeout.mock.calls[1][1]?.method).toBeUndefined();
      expect(mockFetchWithTimeout.mock.calls[2][0]).toMatch(/\/issues\/7\/labels$/);
      expect(JSON.parse(mockFetchWithTimeout.mock.calls[2][1]?.body as string)).toEqual({
        labels: ["open inspect"],
      });
    });

    it("creates a missing label before adding it to the pull request", async () => {
      mockFetchWithTimeout
        .mockResolvedValueOnce(makeResponse(prResponseBody, 201))
        .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404))
        .mockResolvedValueOnce(makeResponse({ name: "generated" }, 201))
        .mockResolvedValueOnce(makeResponse([]));

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      await provider.createPullRequest(fakeAuth, {
        repository: fakeRepository,
        title: "Add feature",
        body: "Body",
        sourceBranch: "feature",
        targetBranch: "main",
        labels: ["generated"],
      });

      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(4);
      expect(mockFetchWithTimeout.mock.calls[2][0]).toMatch(/\/repos\/acme\/web\/labels$/);
      expect(mockFetchWithTimeout.mock.calls[2][1]?.method).toBe("POST");
      expect(JSON.parse(mockFetchWithTimeout.mock.calls[2][1]?.body as string)).toEqual({
        name: "generated",
        color: "ededed",
      });
      expect(mockFetchWithTimeout.mock.calls[3][0]).toMatch(/\/issues\/7\/labels$/);
    });

    it("confirms a concurrent label creation after a 422 response", async () => {
      mockFetchWithTimeout
        .mockResolvedValueOnce(makeResponse(prResponseBody, 201))
        .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404))
        .mockResolvedValueOnce(makeResponse({ message: "Validation Failed" }, 422))
        .mockResolvedValueOnce(makeResponse({ name: "generated" }))
        .mockResolvedValueOnce(makeResponse([]));

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      await provider.createPullRequest(fakeAuth, {
        repository: fakeRepository,
        title: "Add feature",
        body: "Body",
        sourceBranch: "feature",
        targetBranch: "main",
        labels: ["generated"],
      });

      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(5);
      expect(mockFetchWithTimeout.mock.calls[3][0]).toMatch(/\/labels\/generated$/);
      expect(mockFetchWithTimeout.mock.calls[4][0]).toMatch(/\/issues\/7\/labels$/);
    });

    it("logs an unconfirmed 422 label creation failure", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        mockFetchWithTimeout
          .mockResolvedValueOnce(makeResponse(prResponseBody, 201))
          .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404))
          .mockResolvedValueOnce(makeResponse({ message: "Validation Failed" }, 422))
          .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404))
          .mockResolvedValueOnce(makeResponse([]));

        const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
        await provider.createPullRequest(fakeAuth, {
          repository: fakeRepository,
          title: "Add feature",
          body: "Body",
          sourceBranch: "feature",
          targetBranch: "main",
          labels: ["generated"],
        });

        expect(warn).toHaveBeenCalledWith('Failed to create label "generated" in acme/web: 422');
        expect(mockFetchWithTimeout.mock.calls[3][0]).toMatch(/\/labels\/generated$/);
        expect(mockFetchWithTimeout.mock.calls[4][0]).toMatch(/\/issues\/7\/labels$/);
      } finally {
        warn.mockRestore();
      }
    });

    it("throws a SourceControlProviderError when PR creation fails", async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(
        makeResponse("Validation failed: head branch does not exist", 422)
      );

      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
      const err = await provider
        .createPullRequest(fakeAuth, {
          repository: fakeRepository,
          title: "Add feature",
          body: "Body",
          sourceBranch: "feature",
          targetBranch: "main",
          draft: true,
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).httpStatus).toBe(422);
    });
  });
});

// ─── PR lifecycle tracking (getPullRequest + status derivation) ───────────────

import { deriveGitHubPullRequestStatus } from "./github-provider";

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeReviewComment(index: number) {
  const id = 9_000 + index;
  return {
    id,
    body: `Comment ${index}`,
    html_url: `https://github.com/acme/web/pull/7#discussion_r${id}`,
    path: "src/input.ts",
    line: index + 1,
    start_line: null,
    side: "RIGHT",
    start_side: null,
    diff_hunk: "@@ -1 +1 @@",
  };
}

const basePullResponse = {
  number: 7,
  html_url: "https://github.com/acme/web/pull/7",
  url: "https://api.github.com/repos/acme/web/pulls/7",
  state: "open",
  draft: false,
  merged: false,
  updated_at: "2026-07-10T12:00:00Z",
  head: { ref: "open-inspect/session-1", sha: "abc123", repo: { id: 9001, full_name: "acme/web" } },
  base: {
    ref: "main",
    repo: { id: 9001, name: "web", full_name: "acme/web", owner: { login: "acme" } },
  },
};

describe("deriveGitHubPullRequestStatus", () => {
  it("maps an open ready PR", () => {
    expect(deriveGitHubPullRequestStatus({ state: "open", draft: false, merged: false })).toEqual({
      lifecycleState: "open",
      isDraft: false,
    });
  });

  it("maps an open draft PR", () => {
    expect(deriveGitHubPullRequestStatus({ state: "open", draft: true, merged: false })).toEqual({
      lifecycleState: "open",
      isDraft: true,
    });
  });

  it("maps a closed unmerged PR", () => {
    expect(deriveGitHubPullRequestStatus({ state: "closed", draft: false, merged: false })).toEqual(
      { lifecycleState: "closed", isDraft: false }
    );
  });

  it("maps a merged PR and never leaks a stale draft flag (invariant)", () => {
    expect(deriveGitHubPullRequestStatus({ state: "closed", draft: true, merged: true })).toEqual({
      lifecycleState: "merged",
      isDraft: false,
    });
  });

  it("treats null draft/merged (GitHub sends null on old PRs) as false", () => {
    expect(deriveGitHubPullRequestStatus({ state: "open", draft: null, merged: null })).toEqual({
      lifecycleState: "open",
      isDraft: false,
    });
  });
});

describe("getPullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedInstallationToken.mockResolvedValue("installation-token");
  });

  it("throws a permanent error when the App is not configured", async () => {
    const provider = new GitHubSourceControlProvider();
    const err = await provider
      .getPullRequest({ owner: "acme", name: "web", number: 7 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceControlProviderError);
    expect((err as SourceControlProviderError).errorType).toBe("permanent");
  });

  it("reads with app auth and maps the response to a snapshot", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({ ...basePullResponse, draft: true })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const snapshot = await provider.getPullRequest({ owner: "acme", name: "web", number: 7 });

    expect(snapshot).toEqual({
      number: 7,
      url: "https://github.com/acme/web/pull/7",
      lifecycleState: "open",
      isDraft: true,
      headBranch: "open-inspect/session-1",
      baseBranch: "main",
      headSha: "abc123",
      repoOwner: "acme",
      repoName: "web",
      repositoryExternalId: "9001",
      providerUpdatedAt: Date.parse("2026-07-10T12:00:00Z"),
    });

    // App-authenticated: installation token, resolved inside the provider.
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/web/pulls/7",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer installation-token" }),
      })
    );
  });

  it("maps a merged PR to merged with the draft flag suppressed", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({ ...basePullResponse, state: "closed", merged: true, draft: true })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const snapshot = await provider.getPullRequest({ owner: "acme", name: "web", number: 7 });

    expect(snapshot.lifecycleState).toBe("merged");
    expect(snapshot.isDraft).toBe(false);
  });

  it("maps a closed unmerged PR to closed", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({ ...basePullResponse, state: "closed", merged: false })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const snapshot = await provider.getPullRequest({ owner: "acme", name: "web", number: 7 });

    expect(snapshot.lifecycleState).toBe("closed");
  });

  it("maps outcome timestamps (created_at / merged_at / closed_at) into the snapshot", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({
        ...basePullResponse,
        state: "closed",
        merged: true,
        created_at: "2026-07-08T09:00:00Z",
        merged_at: "2026-07-10T12:00:00Z",
        closed_at: "2026-07-10T12:00:00Z",
      })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const snapshot = await provider.getPullRequest({ owner: "acme", name: "web", number: 7 });

    expect(snapshot.providerCreatedAt).toBe(Date.parse("2026-07-08T09:00:00Z"));
    expect(snapshot.mergedAt).toBe(Date.parse("2026-07-10T12:00:00Z"));
    expect(snapshot.closedAt).toBe(Date.parse("2026-07-10T12:00:00Z"));
  });

  it("omits outcome timestamps sent as null (open PR)", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({
        ...basePullResponse,
        created_at: "2026-07-08T09:00:00Z",
        merged_at: null,
        closed_at: null,
      })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const snapshot = await provider.getPullRequest({ owner: "acme", name: "web", number: 7 });

    expect(snapshot.providerCreatedAt).toBe(Date.parse("2026-07-08T09:00:00Z"));
    expect(snapshot.mergedAt).toBeUndefined();
    expect(snapshot.closedAt).toBeUndefined();
  });

  it("resolves the repository by stable id and retries once on 404 (rename tolerance)", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(makeJsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 9001,
          name: "web-renamed",
          full_name: "acme/web-renamed",
          owner: { login: "acme" },
        })
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          ...basePullResponse,
          html_url: "https://github.com/acme/web-renamed/pull/7",
          base: {
            ref: "main",
            repo: {
              id: 9001,
              name: "web-renamed",
              full_name: "acme/web-renamed",
              owner: { login: "acme" },
            },
          },
        })
      );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const snapshot = await provider.getPullRequest({
      owner: "acme",
      name: "web",
      number: 7,
      repositoryExternalId: "9001",
    });

    expect(snapshot.repoName).toBe("web-renamed");
    expect(mockFetchWithTimeout).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repositories/9001",
      expect.anything()
    );
    expect(mockFetchWithTimeout).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/repos/acme/web-renamed/pulls/7",
      expect.anything()
    );
  });

  it("throws with httpStatus 404 when the PR is gone and no stable id is known", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(makeJsonResponse({ message: "Not Found" }, 404));

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const err = await provider
      .getPullRequest({ owner: "acme", name: "web", number: 7 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceControlProviderError);
    expect((err as SourceControlProviderError).httpStatus).toBe(404);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not retry more than once when id resolution also fails", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(makeJsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(makeJsonResponse({ message: "Not Found" }, 404));

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const err = await provider
      .getPullRequest({ owner: "acme", name: "web", number: 7, repositoryExternalId: "9001" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceControlProviderError);
    expect((err as SourceControlProviderError).httpStatus).toBe(404);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
  });
});

describe("getPullRequestFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedInstallationToken.mockResolvedValue("installation-token");
  });

  it("reads a pull request conversation comment authoritatively", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({
        id: 1234,
        body: "Please handle the null case.",
        html_url: "https://github.com/acme/web/pull/7#issuecomment-1234",
        issue_url: "https://api.github.com/repos/acme/web/issues/7",
        user: { id: 77, login: "alice", type: "User" },
      })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const feedback = await provider.getPullRequestFeedback({
      owner: "acme",
      name: "web",
      pullRequestNumber: 7,
      providerObject: { kind: "pr_comment", id: "1234" },
    });

    expect(feedback).toEqual({
      kind: "pr_comment",
      id: "1234",
      body: "Please handle the null case.",
      url: "https://github.com/acme/web/pull/7#issuecomment-1234",
      author: { id: "77", login: "alice", type: "User" },
    });
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/web/issues/comments/1234",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer installation-token" }),
      })
    );
  });

  it("rejects a conversation comment from another pull request", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({
        id: 1234,
        body: "Unrelated feedback.",
        html_url: "https://github.com/acme/web/pull/8#issuecomment-1234",
        issue_url: "https://api.github.com/repos/acme/web/issues/8",
        user: { id: 77, login: "alice", type: "User" },
      })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    await expect(
      provider.getPullRequestFeedback({
        owner: "acme",
        name: "web",
        pullRequestNumber: 7,
        providerObject: { kind: "pr_comment", id: "1234" },
      })
    ).rejects.toMatchObject({
      errorType: "permanent",
      message: "Pull request comment does not belong to the requested pull request",
    });
  });

  it("reads one submitted review with all of its inline comments", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 5678,
          body: "Two issues to address.",
          state: "CHANGES_REQUESTED",
          html_url: "https://github.com/acme/web/pull/7#pullrequestreview-5678",
          pull_request_url: "https://api.github.com/repos/acme/web/pulls/7",
          user: { id: 77, login: "alice", type: "User" },
        })
      )
      .mockResolvedValueOnce(
        makeJsonResponse([
          {
            id: 9001,
            in_reply_to_id: null,
            body: "Handle null here.",
            html_url: "https://github.com/acme/web/pull/7#discussion_r9001",
            path: "src/input.ts",
            line: 12,
            start_line: null,
            side: "RIGHT",
            start_side: null,
            diff_hunk: "@@ -10,2 +10,3 @@",
          },
          {
            id: 9002,
            in_reply_to_id: 8002,
            body: "Add a regression test.",
            html_url: "https://github.com/acme/web/pull/7#discussion_r9002",
            path: "test/input.test.ts",
            line: 24,
            start_line: 20,
            side: "RIGHT",
            start_side: "RIGHT",
            diff_hunk: "@@ -18,2 +18,8 @@",
          },
        ])
      );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const feedback = await provider.getPullRequestFeedback({
      owner: "acme",
      name: "web",
      pullRequestNumber: 7,
      providerObject: { kind: "review", id: "5678" },
    });

    expect(feedback).toMatchObject({
      kind: "review",
      id: "5678",
      body: "Two issues to address.",
      state: "CHANGES_REQUESTED",
      author: { id: "77", login: "alice", type: "User" },
      comments: [
        {
          id: "9001",
          inReplyToId: null,
          body: "Handle null here.",
          path: "src/input.ts",
          line: 12,
        },
        {
          id: "9002",
          inReplyToId: "8002",
          body: "Add a regression test.",
          path: "test/input.test.ts",
          startLine: 20,
        },
      ],
    });
    expect(mockFetchWithTimeout).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/acme/web/pulls/7/reviews/5678/comments?per_page=100&page=1",
      expect.anything()
    );
  });

  it("fetches the next review-comment page when the first page is full", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => makeReviewComment(index));
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 5678,
          body: "Large review.",
          state: "CHANGES_REQUESTED",
          html_url: "https://github.com/acme/web/pull/7#pullrequestreview-5678",
          pull_request_url: "https://api.github.com/repos/acme/web/pulls/7",
          user: { id: 77, login: "alice", type: "User" },
        })
      )
      .mockResolvedValueOnce(makeJsonResponse(firstPage))
      .mockResolvedValueOnce(makeJsonResponse([]));

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const feedback = await provider.getPullRequestFeedback({
      owner: "acme",
      name: "web",
      pullRequestNumber: 7,
      providerObject: { kind: "review", id: "5678" },
    });

    expect(feedback.kind === "review" ? feedback.comments : []).toHaveLength(100);
    expect(mockFetchWithTimeout).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/repos/acme/web/pulls/7/reviews/5678/comments?per_page=100&page=2",
      expect.anything()
    );
  });

  it("rejects a review from another pull request", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({
        id: 5678,
        body: "Unrelated review.",
        state: "CHANGES_REQUESTED",
        html_url: "https://github.com/acme/web/pull/8#pullrequestreview-5678",
        pull_request_url: "https://api.github.com/repos/acme/web/pulls/8",
        user: { id: 77, login: "alice", type: "User" },
      })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    await expect(
      provider.getPullRequestFeedback({
        owner: "acme",
        name: "web",
        pullRequestNumber: 7,
        providerObject: { kind: "review", id: "5678" },
      })
    ).rejects.toMatchObject({
      errorType: "permanent",
      message: "Pull request review does not belong to the requested pull request",
    });
    expect(mockFetchWithTimeout).toHaveBeenCalledOnce();
  });

  it("rejects an oversized review instead of dispatching partial feedback", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => makeReviewComment(index));
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 5678,
          body: "Oversized review.",
          state: "CHANGES_REQUESTED",
          html_url: "https://github.com/acme/web/pull/7#pullrequestreview-5678",
          pull_request_url: "https://api.github.com/repos/acme/web/pulls/7",
          user: { id: 77, login: "alice", type: "User" },
        })
      )
      .mockResolvedValueOnce(makeJsonResponse(firstPage))
      .mockResolvedValueOnce(makeJsonResponse([makeReviewComment(100)]));

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const error = await provider
      .getPullRequestFeedback({
        owner: "acme",
        name: "web",
        pullRequestNumber: 7,
        providerObject: { kind: "review", id: "5678" },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceControlProviderError);
    expect((error as SourceControlProviderError).errorType).toBe("permanent");
    expect((error as Error).message).toContain("100");
  });
});

describe("hasPullRequestWritePermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedInstallationToken.mockResolvedValue("installation-token");
  });

  it.each(["write", "maintain", "admin"] as const)(
    "accepts GitHub %s permission",
    async (permission) => {
      mockFetchWithTimeout.mockResolvedValueOnce(makeJsonResponse({ permission }));
      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

      await expect(
        provider.hasPullRequestWritePermission({
          owner: "acme",
          name: "web",
          authorLogin: "alice",
        })
      ).resolves.toBe(true);
      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/web/collaborators/alice/permission",
        expect.anything()
      );
    }
  );

  it.each(["none", "read", "triage"] as const)(
    "rejects GitHub %s permission",
    async (permission) => {
      mockFetchWithTimeout.mockResolvedValueOnce(makeJsonResponse({ permission }));
      const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

      await expect(
        provider.hasPullRequestWritePermission({
          owner: "acme",
          name: "web",
          authorLogin: "alice",
        })
      ).resolves.toBe(false);
    }
  );

  it("treats a missing collaborator as lacking write permission", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(makeJsonResponse({ message: "Not Found" }, 404));
    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

    await expect(
      provider.hasPullRequestWritePermission({
        owner: "acme",
        name: "web",
        authorLogin: "alice",
      })
    ).resolves.toBe(false);
  });

  it("encodes repository and collaborator path segments", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(makeJsonResponse({ permission: "write" }));
    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

    await provider.hasPullRequestWritePermission({
      owner: "acme org",
      name: "web api",
      authorLogin: "alice/bob",
    });

    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme%20org/web%20api/collaborators/alice%2Fbob/permission",
      expect.anything()
    );
  });
});

describe("createPullRequest state capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures headSha and repositoryExternalId from the create response", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(makeJsonResponse(basePullResponse, 201));

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const result = await provider.createPullRequest(
      { authType: "oauth", token: "user-token" },
      {
        repository: {
          owner: "acme",
          name: "web",
          fullName: "acme/web",
          defaultBranch: "main",
          isPrivate: true,
          providerRepoId: 9001,
        },
        title: "Add feature",
        body: "Description",
        sourceBranch: "open-inspect/session-1",
        targetBranch: "main",
      }
    );

    expect(result.headSha).toBe("abc123");
    expect(result.repositoryExternalId).toBe("9001");
    expect(result.lifecycleState).toBe("open");
    expect(result.isDraft).toBe(false);
    expect(result.providerUpdatedAt).toBe(Date.parse("2026-07-10T12:00:00Z"));
  });

  it("leaves capture fields undefined when the response omits them", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({
        number: 7,
        html_url: "https://github.com/acme/web/pull/7",
        url: "https://api.github.com/repos/acme/web/pulls/7",
        state: "open",
        draft: false,
        merged: false,
        head: { ref: "open-inspect/session-1" },
        base: { ref: "main" },
      })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const result = await provider.createPullRequest(
      { authType: "oauth", token: "user-token" },
      {
        repository: {
          owner: "acme",
          name: "web",
          fullName: "acme/web",
          defaultBranch: "main",
          isPrivate: true,
          providerRepoId: 9001,
        },
        title: "Add feature",
        body: "Description",
        sourceBranch: "open-inspect/session-1",
        targetBranch: "main",
      }
    );

    expect(result.headSha).toBeUndefined();
    expect(result.repositoryExternalId).toBeUndefined();
    expect(result.providerUpdatedAt).toBeUndefined();
  });
});

describe("response validation (zod boundary)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedInstallationToken.mockResolvedValue("installation-token");
  });

  it("getPullRequest throws a permanent provider error on an unexpected state value", async () => {
    // Schema drift must fail loudly, never be silently stored as "open".
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({ ...basePullResponse, state: "reopened" })
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const err = await provider
      .getPullRequest({ owner: "acme", name: "web", number: 7 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceControlProviderError);
    expect((err as SourceControlProviderError).errorType).toBe("permanent");
    expect((err as SourceControlProviderError).message).toContain("state");
  });

  it("getPullRequest throws a permanent provider error on a malformed response", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({ ...basePullResponse, head: {} }) // missing head.ref
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const err = await provider
      .getPullRequest({ owner: "acme", name: "web", number: 7 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceControlProviderError);
    expect((err as SourceControlProviderError).errorType).toBe("permanent");
  });

  it("getPullRequest throws a permanent provider error on non-JSON response body", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      text: () => Promise.resolve("<html>"),
    } as unknown as Response);

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const err = await provider
      .getPullRequest({ owner: "acme", name: "web", number: 7 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceControlProviderError);
    expect((err as SourceControlProviderError).errorType).toBe("permanent");
  });

  it("falls back to the original 404 when the by-id resolution body is malformed", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(makeJsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(makeJsonResponse({ id: 9001 })); // no owner/name

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const err = await provider
      .getPullRequest({ owner: "acme", name: "web", number: 7, repositoryExternalId: "9001" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceControlProviderError);
    expect((err as SourceControlProviderError).httpStatus).toBe(404);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("createPullRequest throws a permanent provider error on a malformed response", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({ html_url: "https://github.com/acme/web/pull/7" }) // missing number etc.
    );

    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });
    const err = await provider
      .createPullRequest(
        { authType: "oauth", token: "user-token" },
        {
          repository: {
            owner: "acme",
            name: "web",
            fullName: "acme/web",
            defaultBranch: "main",
            isPrivate: true,
            providerRepoId: 9001,
          },
          title: "Add feature",
          body: "Description",
          sourceBranch: "open-inspect/session-1",
          targetBranch: "main",
        }
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceControlProviderError);
    expect((err as SourceControlProviderError).errorType).toBe("permanent");
  });
});

describe("managed-skill repository reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedInstallationToken.mockResolvedValue("installation-token");
  });

  it("resolves commits with GitHub's SHA representation", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(new Response("abc123\n"));
    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

    await expect(
      provider.resolveCommit({ owner: "acme", name: "skills", ref: "feature/test" })
    ).resolves.toEqual({ sha: "abc123" });
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining("commits/feature%2Ftest"),
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/vnd.github.sha" }),
      })
    );
  });

  it("returns null for a missing commit ref", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(new Response("", { status: 404 }));
    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

    await expect(
      provider.resolveCommit({ owner: "acme", name: "skills", ref: "missing" })
    ).resolves.toBeNull();
  });

  it("classifies symlinks and submodules as unsupported tree entries", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      makeJsonResponse({
        tree: [
          { path: "SKILL.md", type: "blob", mode: "100644", sha: "file", size: 10 },
          { path: "run.sh", type: "blob", mode: "100755", sha: "exec", size: 5 },
          { path: "link", type: "blob", mode: "120000", sha: "link", size: 8 },
          { path: "module", type: "commit", mode: "160000", sha: "module" },
        ],
      })
    );
    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

    const tree = await provider.listTree({ owner: "acme", name: "skills", commitSha: "abc" });

    expect(tree.entries.map(({ type, executable }) => ({ type, executable }))).toEqual([
      { type: "file", executable: false },
      { type: "file", executable: true },
      { type: "other", executable: false },
      { type: "other", executable: false },
    ]);
  });

  it("resolves and recursively lists only the requested subtree", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        makeJsonResponse({
          tree: [{ path: "skills", type: "tree", mode: "040000", sha: "skills" }],
        })
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          tree: [{ path: "deploy", type: "tree", mode: "040000", sha: "deploy" }],
        })
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          tree: [{ path: "SKILL.md", type: "blob", mode: "100644", sha: "file", size: 10 }],
        })
      );
    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

    const tree = await provider.listTree({
      owner: "acme",
      name: "skills",
      commitSha: "abc",
      path: "skills/deploy",
    });

    expect(tree.entries[0]?.path).toBe("skills/deploy/SKILL.md");
    expect(mockFetchWithTimeout.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/git/trees/abc"),
      expect.stringContaining("/git/trees/skills"),
      expect.stringContaining("/git/trees/deploy?recursive=1"),
    ]);
  });

  it("returns an empty scoped tree when a path segment is missing", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(makeJsonResponse({ tree: [] }));
    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

    await expect(
      provider.listTree({ owner: "acme", name: "skills", commitSha: "abc", path: "missing" })
    ).resolves.toEqual({ entries: [], truncated: false });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("cancels an undeclared oversized blob while streaming it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    });
    mockFetchWithTimeout.mockResolvedValueOnce(new Response(body));
    const provider = new GitHubSourceControlProvider({ appConfig: fakeAppConfig });

    const error = await provider
      .readBlob({ owner: "acme", name: "skills", blobId: "big", maxBytes: 4 })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SourceControlProviderError);
    expect((error as SourceControlProviderError).httpStatus).toBe(413);
    expect(cancelled).toBe(true);
  });
});
