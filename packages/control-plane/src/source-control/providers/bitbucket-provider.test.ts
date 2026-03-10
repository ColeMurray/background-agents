import { afterEach, describe, expect, it, vi } from "vitest";
import { BitbucketSourceControlProvider } from "./bitbucket-provider";
import { SourceControlProviderError } from "../errors";

const originalFetch = global.fetch;

describe("BitbucketSourceControlProvider", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws a permanent error when app credentials are missing", async () => {
    const provider = new BitbucketSourceControlProvider();
    const err = await provider.listRepositories().catch((error: unknown) => error);

    expect(err).toBeInstanceOf(SourceControlProviderError);
    expect((err as SourceControlProviderError).errorType).toBe("permanent");
  });

  it("lists repositories from the configured workspace", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          values: [
            {
              uuid: "{repo-123}",
              name: "web-app",
              full_name: "acme/web-app",
              is_private: true,
              description: "test repo",
              mainbranch: { name: "develop" },
            },
          ],
        }),
        { status: 200 }
      )
    ) as typeof fetch;

    const provider = new BitbucketSourceControlProvider({
      workspace: "acme",
      botUsername: "bot-user",
      botAppPassword: "app-password",
    });

    await expect(provider.listRepositories()).resolves.toEqual([
      {
        id: "repo-123",
        owner: "acme",
        name: "web-app",
        fullName: "acme/web-app",
        description: "test repo",
        private: true,
        defaultBranch: "develop",
      },
    ]);
  });

  it("lists repositories with a user OAuth token when app credentials are absent", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          values: [
            {
              uuid: "{repo-456}",
              name: "api",
              full_name: "acme/api",
              is_private: false,
              mainbranch: { name: "main" },
            },
          ],
        }),
        { status: 200 }
      )
    ) as typeof fetch;

    const provider = new BitbucketSourceControlProvider({
      workspace: "acme",
    });

    await expect(
      provider.listRepositories({
        authType: "oauth",
        token: "user-token-123",
      })
    ).resolves.toEqual([
      {
        id: "repo-456",
        owner: "acme",
        name: "api",
        fullName: "acme/api",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ]);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.bitbucket.org/2.0/repositories/acme?pagelen=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer user-token-123",
          Accept: "application/json",
        }),
      })
    );
  });

  it("rejects OAuth-scoped repository access outside the configured workspace", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          uuid: "{repo-999}",
          name: "secret-repo",
          full_name: "other-workspace/secret-repo",
          is_private: true,
          workspace: { slug: "other-workspace" },
          mainbranch: { name: "main" },
        }),
        { status: 200 }
      )
    ) as typeof fetch;

    const provider = new BitbucketSourceControlProvider({
      workspace: "acme",
    });

    await expect(
      provider.checkRepositoryAccess(
        { owner: "other-workspace", name: "secret-repo" },
        {
          authType: "oauth",
          token: "user-token-123",
        }
      )
    ).rejects.toMatchObject({
      errorType: "permanent",
      httpStatus: 403,
    });
  });

  it("builds provider push spec for bridge execution", () => {
    const provider = new BitbucketSourceControlProvider();
    const spec = provider.buildGitPushSpec({
      owner: "acme",
      name: "web",
      sourceRef: "HEAD",
      targetBranch: "feature/one",
      auth: {
        authType: "token",
        token: "token-123",
      },
    });

    expect(spec).toEqual({
      remoteUrl: "https://x-token-auth:token-123@bitbucket.org/acme/web.git",
      redactedRemoteUrl: "https://x-token-auth:<redacted>@bitbucket.org/acme/web.git",
      refspec: "HEAD:refs/heads/feature/one",
      targetBranch: "feature/one",
      force: false,
    });
  });

  it("paginates Bitbucket branch listing results", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [{ name: "main" }],
            next: "https://api.bitbucket.org/2.0/repositories/acme/web/refs/branches?page=2",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [{ name: "release/1.0" }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uuid: "{repo-456}",
            name: "web",
            full_name: "acme/web",
            is_private: false,
            workspace: { slug: "acme" },
            mainbranch: { name: "main" },
          }),
          { status: 200 }
        )
      ) as typeof fetch;

    const provider = new BitbucketSourceControlProvider({
      workspace: "acme",
    });

    await expect(
      provider.listBranches(
        { owner: "acme", name: "web" },
        {
          authType: "oauth",
          token: "user-token-123",
        }
      )
    ).resolves.toEqual([{ name: "main" }, { name: "release/1.0" }]);

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.bitbucket.org/2.0/repositories/acme/web/refs/branches?pagelen=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer user-token-123",
        }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.bitbucket.org/2.0/repositories/acme/web/refs/branches?page=2",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer user-token-123",
        }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "https://api.bitbucket.org/2.0/repositories/acme/web",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer user-token-123",
        }),
      })
    );
  });

  it("rejects branch enumeration outside the configured workspace", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [{ name: "main" }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uuid: "{repo-999}",
            name: "secret-repo",
            full_name: "other-workspace/secret-repo",
            is_private: true,
            workspace: { slug: "other-workspace" },
            mainbranch: { name: "main" },
          }),
          { status: 200 }
        )
      ) as typeof fetch;

    const provider = new BitbucketSourceControlProvider({
      workspace: "acme",
    });

    await expect(
      provider.listBranches(
        { owner: "other-workspace", name: "secret-repo" },
        {
          authType: "oauth",
          token: "user-token-123",
        }
      )
    ).rejects.toMatchObject({
      errorType: "permanent",
      httpStatus: 403,
    });
  });
});
