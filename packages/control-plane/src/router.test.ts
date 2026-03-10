import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { generateInternalToken } from "./auth/internal";

const originalFetch = global.fetch;

function createUnusedDb(): D1Database {
  return {
    prepare: () => {
      throw new Error("DB should not be used in this test");
    },
    batch: async () => {
      throw new Error("DB should not be used in this test");
    },
    exec: async () => {
      throw new Error("DB should not be used in this test");
    },
  } as unknown as D1Database;
}

function createEmptyKv(): KVNamespace {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace;
}

function createMetadataDb(): D1Database {
  return {
    prepare: () =>
      ({
        bind: () => ({}),
      }) as never,
    batch: async () => [],
    exec: async () => {
      throw new Error("exec should not be used in this test");
    },
  } as unknown as D1Database;
}

function createEnabledReposDb(
  repos: Array<{ repo_owner: string; repo_name: string }>
): D1Database {
  return {
    prepare: (query: string) => {
      if (query === "SELECT repo_owner, repo_name FROM repo_metadata WHERE image_build_enabled = 1") {
        return {
          bind: () => ({
            all: async () => ({ results: repos }),
          }),
          all: async () => ({ results: repos }),
        } as never;
      }

      throw new Error(`Unexpected query in test DB: ${query}`);
    },
    batch: async () => {
      throw new Error("batch should not be used in this test");
    },
    exec: async () => {
      throw new Error("exec should not be used in this test");
    },
  } as unknown as D1Database;
}

describe("handleRequest SCM provider routing", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not reject authenticated Bitbucket requests before route matching", async () => {
    const env = {
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
      SCM_PROVIDER: "bitbucket",
      DB: createUnusedDb(),
    } as never;

    const token = await generateInternalToken("test-internal-secret");
    const response = await handleRequest(
      new Request("https://test.local/unknown-path", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("infers bitbucket for /repos when SCM_PROVIDER is unset", async () => {
    const env = {
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
      BITBUCKET_WORKSPACE: "acme",
      REPOS_CACHE: createEmptyKv(),
      DB: createUnusedDb(),
    } as never;

    const token = await generateInternalToken("test-internal-secret");
    const response = await handleRequest(
      new Request("https://test.local/repos", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Bitbucket app credentials not configured",
    });
  });

  it("bypasses shared repo cache for Bitbucket OAuth-scoped repo discovery", async () => {
    const cache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } satisfies Partial<KVNamespace>;

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          values: [
            {
              uuid: "{repo-123}",
              name: "web-app",
              full_name: "acme/web-app",
              is_private: true,
              mainbranch: { name: "main" },
            },
          ],
        }),
        { status: 200 }
      )
    ) as typeof fetch;

    const env = {
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
      SCM_PROVIDER: "bitbucket",
      BITBUCKET_WORKSPACE: "acme",
      REPOS_CACHE: cache,
      DB: createMetadataDb(),
    } as never;

    const token = await generateInternalToken("test-internal-secret");
    const response = await handleRequest(
      new Request("https://test.local/repos", {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-scm-token": "user-token-123",
        },
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repos: [
        {
          id: "repo-123",
          owner: "acme",
          name: "web-app",
          fullName: "acme/web-app",
          description: null,
          private: true,
          defaultBranch: "main",
        },
      ],
      cached: false,
      cachedAt: expect.any(String),
    });
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("rejects session creation for Bitbucket repositories outside the configured workspace", async () => {
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

    const env = {
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
      SCM_PROVIDER: "bitbucket",
      BITBUCKET_WORKSPACE: "acme",
      REPOS_CACHE: createEmptyKv(),
      DB: createUnusedDb(),
      SESSION: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) as DurableObjectStub,
      },
    } as never;

    const token = await generateInternalToken("test-internal-secret");
    const response = await handleRequest(
      new Request("https://test.local/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repoOwner: "other-workspace",
          repoName: "secret-repo",
          scmToken: "user-token-123",
        }),
      }),
      env
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to resolve repository",
    });
  });

  it("rejects Bitbucket branch listing outside the configured workspace", async () => {
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

    const env = {
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
      SCM_PROVIDER: "bitbucket",
      BITBUCKET_WORKSPACE: "acme",
      REPOS_CACHE: createEmptyKv(),
      DB: createUnusedDb(),
    } as never;

    const token = await generateInternalToken("test-internal-secret");
    const response = await handleRequest(
      new Request("https://test.local/repos/other-workspace/secret-repo/branches", {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-scm-token": "user-token-123",
        },
      }),
      env
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to list branches",
    });
  });

  it("skips repos that fail SCM enrichment when listing enabled repo images", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url === "https://bitbucket.org/site/oauth2/access_token") {
        return new Response(
          JSON.stringify({
            access_token: "app-token-123",
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/repositories/acme/repo-a")) {
        return new Response(
          JSON.stringify({
            uuid: "{repo-123}",
            name: "repo-a",
            full_name: "acme/repo-a",
            is_private: true,
            mainbranch: { name: "main" },
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/repositories/acme/repo-a/refs/branches/main")) {
        return new Response(
          JSON.stringify({
            target: { hash: "sha-repo-a" },
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/repositories/acme/repo-b")) {
        return new Response("upstream error", { status: 500 });
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }) as typeof fetch;

    const env = {
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
      SCM_PROVIDER: "bitbucket",
      BITBUCKET_WORKSPACE: "acme",
      BITBUCKET_CLIENT_ID: "client-id",
      BITBUCKET_CLIENT_SECRET: "client-secret",
      REPOS_CACHE: createEmptyKv(),
      DB: createEnabledReposDb([
        { repo_owner: "acme", repo_name: "repo-a" },
        { repo_owner: "acme", repo_name: "repo-b" },
      ]),
    } as never;

    const token = await generateInternalToken("test-internal-secret");
    const response = await handleRequest(
      new Request("https://test.local/repo-images/enabled-repos", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repos: [
        {
          repoOwner: "acme",
          repoName: "repo-a",
          defaultBranch: "main",
          headSha: "sha-repo-a",
        },
      ],
    });
  });
});
