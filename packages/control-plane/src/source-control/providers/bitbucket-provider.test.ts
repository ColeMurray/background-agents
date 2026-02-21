import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BitbucketSourceControlProvider } from "./bitbucket-provider";
import { SourceControlProviderError } from "../errors";

describe("BitbucketSourceControlProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds manual pull request URL with encoded components", () => {
    const provider = new BitbucketSourceControlProvider();
    const url = provider.buildManualPullRequestUrl({
      owner: "acme org",
      name: "web/app",
      sourceBranch: "feature/test branch",
      targetBranch: "main",
    });

    expect(url).toBe(
      "https://bitbucket.org/acme%20org/web%2Fapp/pull-requests/new?source=feature%2Ftest%20branch&dest=main"
    );
  });

  it("builds provider push spec for bridge execution", () => {
    const provider = new BitbucketSourceControlProvider({ botUsername: "bot-user" });
    const spec = provider.buildGitPushSpec({
      owner: "acme",
      name: "web",
      sourceRef: "HEAD",
      targetBranch: "feature/one",
      auth: {
        authType: "pat",
        token: "token-123",
      },
      force: true,
    });

    expect(spec).toEqual({
      remoteUrl: "https://bot-user:token-123@bitbucket.org/acme/web.git",
      redactedRemoteUrl: "https://bot-user:<redacted>@bitbucket.org/acme/web.git",
      refspec: "HEAD:refs/heads/feature/one",
      targetBranch: "feature/one",
      force: true,
    });
  });

  it("requires bot app password for push auth", async () => {
    const provider = new BitbucketSourceControlProvider();
    await expect(provider.generatePushAuth()).rejects.toThrow(SourceControlProviderError);
  });

  it("maps repository response shape", async () => {
    const provider = new BitbucketSourceControlProvider();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          uuid: "{123}",
          name: "web",
          full_name: "acme/web",
          is_private: true,
          owner: { username: "acme" },
          mainbranch: { name: "develop" },
        }),
        { status: 200 }
      )
    );

    const repo = await provider.getRepository(
      { authType: "oauth", token: "oauth-token" },
      { owner: "acme", name: "web" }
    );

    expect(repo).toEqual({
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      defaultBranch: "develop",
      isPrivate: true,
      providerRepoId: "{123}",
    });
  });

  it("maps PR response shape", async () => {
    const provider = new BitbucketSourceControlProvider();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 42,
          state: "OPEN",
          source: { branch: { name: "feature/test" } },
          destination: { branch: { name: "main" } },
          links: {
            html: { href: "https://bitbucket.org/acme/web/pull-requests/42" },
            self: { href: "https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests/42" },
          },
        }),
        { status: 200 }
      )
    );

    const result = await provider.createPullRequest(
      { authType: "oauth", token: "oauth-token" },
      {
        repository: {
          owner: "acme",
          name: "web",
          fullName: "acme/web",
          defaultBranch: "main",
          isPrivate: true,
          providerRepoId: "repo-1",
        },
        title: "Test PR",
        body: "PR body",
        sourceBranch: "feature/test",
        targetBranch: "main",
      }
    );

    expect(result).toEqual({
      id: 42,
      webUrl: "https://bitbucket.org/acme/web/pull-requests/42",
      apiUrl: "https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests/42",
      state: "open",
      sourceBranch: "feature/test",
      targetBranch: "main",
    });
  });

  it("classifies API errors as provider errors", async () => {
    const provider = new BitbucketSourceControlProvider();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));

    await expect(
      provider.getRepository(
        { authType: "oauth", token: "bad-token" },
        { owner: "acme", name: "web" }
      )
    ).rejects.toThrow(SourceControlProviderError);
  });
});
