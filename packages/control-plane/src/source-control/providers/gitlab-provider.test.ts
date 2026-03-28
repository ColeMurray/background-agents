import { describe, expect, it, vi, beforeEach } from "vitest";
import { GitLabSourceControlProvider } from "./gitlab-provider";
import { SourceControlProviderError } from "../errors";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const fakeConfig = { accessToken: "glpat-test-token" };

describe("GitLabSourceControlProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("getRepository", () => {
    it("maps GitLab project response to RepositoryInfo using path not display name", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          id: 42,
          name: "My Web App", // display name — should NOT be used
          path: "web", // URL slug — should be used as name
          path_with_namespace: "acme/web",
          namespace: { path: "acme" },
          default_branch: "main",
          visibility: "private",
        })
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const repo = await provider.getRepository(
        { authType: "pat", token: "user-token" },
        { owner: "acme", name: "web" }
      );

      expect(repo).toEqual({
        owner: "acme",
        name: "web", // path, not display name
        fullName: "acme/web",
        defaultBranch: "main",
        isPrivate: true,
        providerRepoId: 42,
      });
    });

    it("marks public repos as not private", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          id: 7,
          name: "OSS Project",
          path: "oss",
          path_with_namespace: "acme/oss",
          namespace: { path: "acme" },
          default_branch: "main",
          visibility: "public",
        })
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const repo = await provider.getRepository(
        { authType: "pat", token: "user-token" },
        { owner: "acme", name: "oss" }
      );

      expect(repo.isPrivate).toBe(false);
    });

    it("throws transient error on 429", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse("rate limited", 429));

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const err = await provider
        .getRepository({ authType: "pat", token: "user-token" }, { owner: "acme", name: "web" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("transient");
      expect((err as SourceControlProviderError).httpStatus).toBe(429);
    });

    it("throws permanent error on 401", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse("unauthorized", 401));

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const err = await provider
        .getRepository({ authType: "pat", token: "user-token" }, { owner: "acme", name: "web" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("permanent");
      expect((err as SourceControlProviderError).httpStatus).toBe(401);
    });
  });

  describe("createPullRequest", () => {
    it("maps GitLab MR response to CreatePullRequestResult", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          iid: 5,
          web_url: "https://gitlab.com/acme/web/-/merge_requests/5",
          _links: { self: "https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/5" },
          state: "opened",
          draft: false,
          source_branch: "feature/foo",
          target_branch: "main",
        })
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const result = await provider.createPullRequest(
        { authType: "pat", token: "user-token" },
        {
          repository: {
            owner: "acme",
            name: "web",
            fullName: "acme/web",
            defaultBranch: "main",
            isPrivate: true,
            providerRepoId: 42,
          },
          title: "Add feature",
          body: "Description",
          sourceBranch: "feature/foo",
          targetBranch: "main",
        }
      );

      expect(result).toEqual({
        id: 5,
        webUrl: "https://gitlab.com/acme/web/-/merge_requests/5",
        apiUrl: "https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/5",
        state: "open",
        sourceBranch: "feature/foo",
        targetBranch: "main",
      });
    });

    it("prefixes title with 'Draft: ' when draft is requested", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve(
          makeResponse({
            iid: 6,
            web_url: "https://gitlab.com/acme/web/-/merge_requests/6",
            _links: { self: "https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/6" },
            state: "opened",
            draft: true,
            source_branch: "feature/bar",
            target_branch: "main",
          })
        );
      });

      const provider = new GitLabSourceControlProvider(fakeConfig);
      await provider.createPullRequest(
        { authType: "pat", token: "user-token" },
        {
          repository: {
            owner: "acme",
            name: "web",
            fullName: "acme/web",
            defaultBranch: "main",
            isPrivate: true,
            providerRepoId: 42,
          },
          title: "WIP change",
          body: "",
          sourceBranch: "feature/bar",
          targetBranch: "main",
          draft: true,
        }
      );

      expect(capturedBody?.title).toBe("Draft: WIP change");
    });

    it("does not double-prefix when title already starts with 'Draft: '", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve(
          makeResponse({
            iid: 7,
            web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
            _links: { self: "https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/7" },
            state: "opened",
            draft: true,
            source_branch: "feature/baz",
            target_branch: "main",
          })
        );
      });

      const provider = new GitLabSourceControlProvider(fakeConfig);
      await provider.createPullRequest(
        { authType: "pat", token: "user-token" },
        {
          repository: {
            owner: "acme",
            name: "web",
            fullName: "acme/web",
            defaultBranch: "main",
            isPrivate: true,
            providerRepoId: 42,
          },
          title: "Draft: already prefixed",
          body: "",
          sourceBranch: "feature/baz",
          targetBranch: "main",
          draft: true,
        }
      );

      expect(capturedBody?.title).toBe("Draft: already prefixed");
    });

    it("maps merged MR state correctly", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          iid: 8,
          web_url: "https://gitlab.com/acme/web/-/merge_requests/8",
          _links: { self: "https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/8" },
          state: "merged",
          draft: false,
          source_branch: "feature/done",
          target_branch: "main",
        })
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const result = await provider.createPullRequest(
        { authType: "pat", token: "user-token" },
        {
          repository: {
            owner: "acme",
            name: "web",
            fullName: "acme/web",
            defaultBranch: "main",
            isPrivate: true,
            providerRepoId: 42,
          },
          title: "Merged MR",
          body: "",
          sourceBranch: "feature/done",
          targetBranch: "main",
        }
      );

      expect(result.state).toBe("merged");
    });

    it("maps closed MR state correctly", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          iid: 9,
          web_url: "https://gitlab.com/acme/web/-/merge_requests/9",
          _links: { self: "https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/9" },
          state: "closed",
          draft: false,
          source_branch: "feature/abandoned",
          target_branch: "main",
        })
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const result = await provider.createPullRequest(
        { authType: "pat", token: "user-token" },
        {
          repository: {
            owner: "acme",
            name: "web",
            fullName: "acme/web",
            defaultBranch: "main",
            isPrivate: true,
            providerRepoId: 42,
          },
          title: "Closed MR",
          body: "",
          sourceBranch: "feature/abandoned",
          targetBranch: "main",
        }
      );

      expect(result.state).toBe("closed");
    });

    it("maps draft MR state correctly", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          iid: 10,
          web_url: "https://gitlab.com/acme/web/-/merge_requests/10",
          _links: { self: "https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/10" },
          state: "opened",
          draft: true,
          source_branch: "feature/wip",
          target_branch: "main",
        })
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const result = await provider.createPullRequest(
        { authType: "pat", token: "user-token" },
        {
          repository: {
            owner: "acme",
            name: "web",
            fullName: "acme/web",
            defaultBranch: "main",
            isPrivate: true,
            providerRepoId: 42,
          },
          title: "Draft: WIP feature",
          body: "",
          sourceBranch: "feature/wip",
          targetBranch: "main",
        }
      );

      expect(result.state).toBe("draft");
    });
  });

  describe("checkRepositoryAccess", () => {
    it("returns access result for accessible repo", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          id: 99,
          namespace: { path: "acme" },
          path: "web",
          default_branch: "main",
        })
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const result = await provider.checkRepositoryAccess({ owner: "acme", name: "web" });

      expect(result).toEqual({
        repoId: 99,
        repoOwner: "acme",
        repoName: "web",
        defaultBranch: "main",
      });
    });

    it("returns null for 404", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse("not found", 404));

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const result = await provider.checkRepositoryAccess({ owner: "acme", name: "missing" });

      expect(result).toBeNull();
    });

    it("throws on non-404 API errors", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse("internal server error", 500));

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const err = await provider
        .checkRepositoryAccess({ owner: "acme", name: "web" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).httpStatus).toBe(500);
    });

    it("normalizes owner and name to lowercase", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          id: 1,
          namespace: { path: "ACME" },
          path: "WEB",
          default_branch: "main",
        })
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const result = await provider.checkRepositoryAccess({ owner: "ACME", name: "WEB" });

      expect(result?.repoOwner).toBe("acme");
      expect(result?.repoName).toBe("web");
    });
  });

  describe("listRepositories", () => {
    it("fetches from /projects endpoint when no namespace is configured", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse([
          {
            id: 1,
            name: "My Web App", // display name — should NOT be used
            path: "web", // URL slug — should be used as name
            path_with_namespace: "acme/web",
            namespace: { path: "acme" },
            description: "The web app",
            visibility: "private",
            default_branch: "main",
          },
        ])
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const repos = await provider.listRepositories();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects?membership=true"),
        expect.any(Object)
      );
      expect(repos).toHaveLength(1);
      expect(repos[0]).toEqual({
        id: 1,
        owner: "acme",
        name: "web", // path, not display name
        fullName: "acme/web",
        description: "The web app",
        private: true,
        defaultBranch: "main",
      });
    });

    it("fetches from group endpoint when namespace is configured", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse([]));

      const provider = new GitLabSourceControlProvider({
        accessToken: "glpat-test",
        namespace: "my-group",
      });
      await provider.listRepositories();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/groups/my-group/projects"),
        expect.any(Object)
      );
    });

    it("throws transient error on 429", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse("rate limited", 429));

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const err = await provider.listRepositories().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SourceControlProviderError);
      expect((err as SourceControlProviderError).errorType).toBe("transient");
    });
  });

  describe("listBranches", () => {
    it("returns branch names from API response", async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse([{ name: "main" }, { name: "develop" }, { name: "feature/foo" }])
      );

      const provider = new GitLabSourceControlProvider(fakeConfig);
      const branches = await provider.listBranches({ owner: "acme", name: "web" });

      expect(branches).toEqual([{ name: "main" }, { name: "develop" }, { name: "feature/foo" }]);
    });
  });

  describe("generatePushAuth", () => {
    it("returns PAT-type auth context with configured token", async () => {
      const provider = new GitLabSourceControlProvider({ accessToken: "glpat-abc123" });
      const auth = await provider.generatePushAuth();

      expect(auth).toEqual({ authType: "pat", token: "glpat-abc123" });
    });
  });

  describe("buildManualPullRequestUrl", () => {
    it("builds correct GitLab MR creation URL", () => {
      const provider = new GitLabSourceControlProvider(fakeConfig);
      const url = provider.buildManualPullRequestUrl({
        owner: "acme",
        name: "web",
        sourceBranch: "feature/add-thing",
        targetBranch: "main",
      });

      expect(url).toBe(
        "https://gitlab.com/acme/web/-/merge_requests/new" +
          "?merge_request[source_branch]=feature%2Fadd-thing" +
          "&merge_request[target_branch]=main"
      );
    });

    it("URL-encodes owner and repo name", () => {
      const provider = new GitLabSourceControlProvider(fakeConfig);
      const url = provider.buildManualPullRequestUrl({
        owner: "acme org",
        name: "web/app",
        sourceBranch: "feature/test branch",
        targetBranch: "main",
      });

      expect(url).toContain("acme%20org");
      expect(url).toContain("web%2Fapp");
      expect(url).toContain("feature%2Ftest%20branch");
    });
  });

  describe("buildGitPushSpec", () => {
    it("builds correct GitLab push spec", () => {
      const provider = new GitLabSourceControlProvider(fakeConfig);
      const spec = provider.buildGitPushSpec({
        owner: "acme",
        name: "web",
        sourceRef: "HEAD",
        targetBranch: "feature/one",
        auth: { authType: "pat", token: "glpat-secret" },
        force: false,
      });

      expect(spec).toEqual({
        remoteUrl: "https://oauth2:glpat-secret@gitlab.com/acme/web.git",
        redactedRemoteUrl: "https://oauth2:<redacted>@gitlab.com/acme/web.git",
        refspec: "HEAD:refs/heads/feature/one",
        targetBranch: "feature/one",
        force: false,
      });
    });

    it("defaults push spec to non-force push", () => {
      const provider = new GitLabSourceControlProvider(fakeConfig);
      const spec = provider.buildGitPushSpec({
        owner: "acme",
        name: "web",
        sourceRef: "HEAD",
        targetBranch: "main",
        auth: { authType: "pat", token: "glpat-secret" },
      });

      expect(spec.force).toBe(false);
    });

    it("supports force push", () => {
      const provider = new GitLabSourceControlProvider(fakeConfig);
      const spec = provider.buildGitPushSpec({
        owner: "acme",
        name: "web",
        sourceRef: "HEAD",
        targetBranch: "main",
        auth: { authType: "pat", token: "glpat-secret" },
        force: true,
      });

      expect(spec.force).toBe(true);
    });

    it("redacts token in redactedRemoteUrl", () => {
      const provider = new GitLabSourceControlProvider(fakeConfig);
      const spec = provider.buildGitPushSpec({
        owner: "acme",
        name: "web",
        sourceRef: "HEAD",
        targetBranch: "main",
        auth: { authType: "pat", token: "glpat-super-secret" },
      });

      expect(spec.remoteUrl).toContain("glpat-super-secret");
      expect(spec.redactedRemoteUrl).not.toContain("glpat-super-secret");
      expect(spec.redactedRemoteUrl).toContain("<redacted>");
    });

    it("uses literal (unencoded) path segments in remote URL", () => {
      const provider = new GitLabSourceControlProvider(fakeConfig);
      const spec = provider.buildGitPushSpec({
        owner: "acme",
        name: "my-repo",
        sourceRef: "HEAD",
        targetBranch: "main",
        auth: { authType: "pat", token: "glpat-secret" },
      });

      // git expects literal path segments, not percent-encoded ones
      expect(spec.remoteUrl).toBe("https://oauth2:glpat-secret@gitlab.com/acme/my-repo.git");
      expect(spec.redactedRemoteUrl).toBe("https://oauth2:<redacted>@gitlab.com/acme/my-repo.git");
    });
  });
});
