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

// ─── PR lifecycle tracking (getPullRequest + status derivation) ───────────────

import { fetchWithTimeout, getCachedInstallationToken } from "../../auth/github-app";
import { deriveGitHubPullRequestStatus } from "./github-provider";

const mockFetchWithTimeout = vi.mocked(fetchWithTimeout);
const mockGetCachedInstallationToken = vi.mocked(getCachedInstallationToken);

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
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
    expect(result.state).toBe("open");
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
