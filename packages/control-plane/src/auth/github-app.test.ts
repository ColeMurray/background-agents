import { afterEach, describe, it, expect, vi } from "vitest";
import {
  isGitHubAppConfigured,
  getGitHubAppConfig,
  getCachedInstallationToken,
  getCachedInstallationTokenWithExpiry,
  getInstallationRepository,
  INSTALLATION_TOKEN_CACHE_MAX_AGE_MS,
  INSTALLATION_TOKEN_MIN_REMAINING_MS,
  listInstallationRepositories,
  listRepositoryBranches,
} from "./github-app";
import type { CacheStore } from "@open-inspect/shared/cache-store";

class FakeCacheStore implements CacheStore {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null>;
  async get(key: string, type: "json"): Promise<unknown | null>;
  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const value = this.store.get(key);
    if (value == null) {
      return null;
    }
    if (type !== "json") {
      return value;
    }
    return JSON.parse(value);
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** Generate a PKCS#8 PEM RSA key pair for testing. */
async function generateTestKeyPair(): Promise<{ privateKeyPem: string }> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;

  const exported = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
  const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  const lines = base64.match(/.{1,64}/g)!.join("\n");
  return { privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----` };
}

const cachedTokenConfig = (suffix: string) => ({
  appId: `app-${suffix}-${Date.now()}`,
  privateKey: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
  installationId: `installation-${suffix}`,
});

async function cacheInstallationToken(
  cacheStore: FakeCacheStore,
  config: ReturnType<typeof cachedTokenConfig>
): Promise<void> {
  await cacheStore.put(
    `github:installation-token:v2:${config.appId}:${config.installationId}:all`,
    JSON.stringify({
      token: "cached-token",
      expiresAtEpochMs:
        Date.now() + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS + INSTALLATION_TOKEN_MIN_REMAINING_MS,
      cachedAtEpochMs: Date.now(),
    })
  );
}

const githubRepoResponse = {
  id: 123,
  name: "background-agents",
  full_name: "open-inspect/background-agents",
  description: null,
  private: true,
  archived: false,
  default_branch: "main",
  language: null,
  topics: ["agents", "automation"],
  owner: { login: "open-inspect" },
};

describe("github-app utilities", () => {
  describe("isGitHubAppConfigured", () => {
    it("returns true when all credentials are present", () => {
      const env = {
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        GITHUB_APP_INSTALLATION_ID: "67890",
      };

      expect(isGitHubAppConfigured(env)).toBe(true);
    });

    it("returns false when GITHUB_APP_ID is missing", () => {
      const env = {
        GITHUB_APP_PRIVATE_KEY: "key",
        GITHUB_APP_INSTALLATION_ID: "67890",
      };

      expect(isGitHubAppConfigured(env)).toBe(false);
    });

    it("returns false when GITHUB_APP_PRIVATE_KEY is missing", () => {
      const env = {
        GITHUB_APP_ID: "12345",
        GITHUB_APP_INSTALLATION_ID: "67890",
      };

      expect(isGitHubAppConfigured(env)).toBe(false);
    });

    it("returns false when GITHUB_APP_INSTALLATION_ID is missing", () => {
      const env = {
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "key",
      };

      expect(isGitHubAppConfigured(env)).toBe(false);
    });

    it("returns false when all credentials are missing", () => {
      expect(isGitHubAppConfigured({})).toBe(false);
    });

    it("returns false for empty string values", () => {
      const env = {
        GITHUB_APP_ID: "",
        GITHUB_APP_PRIVATE_KEY: "key",
        GITHUB_APP_INSTALLATION_ID: "67890",
      };

      expect(isGitHubAppConfigured(env)).toBe(false);
    });
  });

  describe("getGitHubAppConfig", () => {
    it("returns config when all credentials are present", () => {
      const env = {
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        GITHUB_APP_INSTALLATION_ID: "67890",
      };

      const config = getGitHubAppConfig(env);

      expect(config).toEqual({
        appId: "12345",
        privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        installationId: "67890",
      });
    });

    it("returns null when credentials are incomplete", () => {
      expect(getGitHubAppConfig({})).toBeNull();
      expect(
        getGitHubAppConfig({
          GITHUB_APP_ID: "12345",
        })
      ).toBeNull();
      expect(
        getGitHubAppConfig({
          GITHUB_APP_ID: "12345",
          GITHUB_APP_PRIVATE_KEY: "key",
        })
      ).toBeNull();
    });
  });

  describe("getCachedInstallationToken", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("reads valid token from KV cache", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const cacheStore = new FakeCacheStore();

      const config = {
        appId: `app-kv-${Date.now()}`,
        privateKey: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
        installationId: "installation-2",
      };

      await cacheStore.put(
        `github:installation-token:v2:${config.appId}:${config.installationId}:all`,
        JSON.stringify({
          token: "token-from-kv",
          expiresAtEpochMs:
            Date.now() + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS + INSTALLATION_TOKEN_MIN_REMAINING_MS,
          cachedAtEpochMs: Date.now(),
        })
      );

      const token = await getCachedInstallationToken(
        config,
        { cacheStore },
        { scope: { kind: "all" } }
      );

      expect(token).toBe("token-from-kv");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("treats a malformed KV token as a cache miss", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const cacheStore = new FakeCacheStore();
      const { privateKeyPem } = await generateTestKeyPair();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ token: "fresh-token", expires_at: expiresAt }), {
          status: 201,
        })
      );

      const config = {
        appId: `app-kv-malformed-${Date.now()}`,
        privateKey: privateKeyPem,
        installationId: "installation-malformed-cache",
      };
      await cacheStore.put(
        `github:installation-token:v2:${config.appId}:${config.installationId}:all`,
        JSON.stringify({
          token: 42,
          expiresAtEpochMs: Date.parse(expiresAt),
          cachedAtEpochMs: Date.now(),
        })
      );

      await expect(
        getCachedInstallationToken(config, { cacheStore }, { scope: { kind: "all" } })
      ).resolves.toBe("fresh-token");
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe("getCachedInstallationTokenWithExpiry", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns the cached token + expiresAtEpochMs from a KV hit", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const cacheStore = new FakeCacheStore();

      const config = {
        appId: `app-with-expiry-${Date.now()}`,
        privateKey: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
        installationId: "installation-with-expiry",
      };

      const expiresAtEpochMs =
        Date.now() + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS + INSTALLATION_TOKEN_MIN_REMAINING_MS;
      await cacheStore.put(
        `github:installation-token:v2:${config.appId}:${config.installationId}:all`,
        JSON.stringify({
          token: "tok-with-expiry",
          expiresAtEpochMs,
          cachedAtEpochMs: Date.now(),
        })
      );

      const result = await getCachedInstallationTokenWithExpiry(
        config,
        { cacheStore },
        { scope: { kind: "all" } }
      );

      expect(result).toEqual({ token: "tok-with-expiry", expiresAtEpochMs });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("matches getCachedInstallationToken on the .token field", async () => {
      const cacheStore = new FakeCacheStore();

      const config = {
        appId: `app-parity-${Date.now()}`,
        privateKey: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
        installationId: "installation-parity",
      };

      await cacheStore.put(
        `github:installation-token:v2:${config.appId}:${config.installationId}:all`,
        JSON.stringify({
          token: "shared-token",
          expiresAtEpochMs:
            Date.now() + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS + INSTALLATION_TOKEN_MIN_REMAINING_MS,
          cachedAtEpochMs: Date.now(),
        })
      );

      const plain = await getCachedInstallationToken(
        config,
        { cacheStore },
        { scope: { kind: "all" } }
      );
      const withExpiry = await getCachedInstallationTokenWithExpiry(
        config,
        { cacheStore },
        { scope: { kind: "all" } }
      );

      expect(withExpiry.token).toBe(plain);
    });

    it("parses a valid GitHub installation token response", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const { privateKeyPem } = await generateTestKeyPair();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ token: "fresh-token", expires_at: expiresAt }), {
          status: 201,
        })
      );

      const result = await getCachedInstallationTokenWithExpiry(
        {
          appId: `app-refresh-valid-${Date.now()}`,
          privateKey: privateKeyPem,
          installationId: "installation-refresh-valid",
        },
        undefined,
        { scope: { kind: "all" }, forceRefresh: true }
      );

      expect(result).toEqual({ token: "fresh-token", expiresAtEpochMs: Date.parse(expiresAt) });
    });

    it("signs with a key whose newlines are the two characters backslash-n", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const { privateKeyPem } = await generateTestKeyPair();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ token: "escaped-key-token", expires_at: expiresAt }), {
          status: 201,
        })
      );

      const result = await getCachedInstallationTokenWithExpiry(
        {
          appId: `app-escaped-key-${Date.now()}`,
          privateKey: privateKeyPem.replace(/\n/g, "\\n"),
          installationId: "installation-escaped-key",
        },
        undefined,
        { scope: { kind: "all" }, forceRefresh: true }
      );

      expect(result.token).toBe("escaped-key-token");
    });

    it("rejects a malformed GitHub installation token response", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const { privateKeyPem } = await generateTestKeyPair();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ token: "missing-expiry" }), { status: 201 })
      );

      await expect(
        getCachedInstallationTokenWithExpiry(
          {
            appId: `app-refresh-invalid-${Date.now()}`,
            privateKey: privateKeyPem,
            installationId: "installation-refresh-invalid",
          },
          undefined,
          { scope: { kind: "all" }, forceRefresh: true }
        )
      ).rejects.toThrow("Failed to get installation token: invalid response");
    });

    it("rejects an invalid JSON GitHub installation token response", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const { privateKeyPem } = await generateTestKeyPair();
      fetchMock.mockResolvedValue(new Response("not json", { status: 201 }));

      await expect(
        getCachedInstallationTokenWithExpiry(
          {
            appId: `app-refresh-invalid-json-${Date.now()}`,
            privateKey: privateKeyPem,
            installationId: "installation-refresh-invalid-json",
          },
          undefined,
          { scope: { kind: "all" }, forceRefresh: true }
        )
      ).rejects.toThrow("Failed to get installation token: invalid response");
    });

    it("rejects an unparsable GitHub installation token expiry", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const { privateKeyPem } = await generateTestKeyPair();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ token: "fresh-token", expires_at: "not-a-date" }), {
          status: 201,
        })
      );

      await expect(
        getCachedInstallationTokenWithExpiry(
          {
            appId: `app-refresh-invalid-expiry-${Date.now()}`,
            privateKey: privateKeyPem,
            installationId: "installation-refresh-invalid-expiry",
          },
          undefined,
          { scope: { kind: "all" }, forceRefresh: true }
        )
      ).rejects.toThrow("Failed to get installation token: invalid response");
    });
  });

  describe("GitHub API response parsing", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("parses installation repositories with nullable GitHub fields", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig("list-repos-valid");
      await cacheInstallationToken(cacheStore, config);
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            total_count: 1,
            repository_selection: "selected",
            repositories: [githubRepoResponse],
          })
        )
      );

      const result = await listInstallationRepositories(config, { cacheStore });

      expect(result.repos).toEqual([
        {
          id: 123,
          owner: "open-inspect",
          name: "background-agents",
          fullName: "open-inspect/background-agents",
          description: null,
          private: true,
          archived: false,
          defaultBranch: "main",
          language: null,
          topics: ["agents", "automation"],
        },
      ]);
      expect(result.timing.totalRepos).toBe(1);
    });

    it("rejects malformed installation repository list responses", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig("list-repos-invalid");
      await cacheInstallationToken(cacheStore, config);
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ total_count: 1, repositories: [{ ...githubRepoResponse, id: "123" }] })
        )
      );

      await expect(listInstallationRepositories(config, { cacheStore })).rejects.toThrow(
        "Failed to list installation repositories (page 1): invalid response"
      );
    });

    it("parses single repository responses with nullable descriptions", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig("get-repo-valid");
      await cacheInstallationToken(cacheStore, config);
      fetchMock.mockResolvedValue(new Response(JSON.stringify(githubRepoResponse)));

      const result = await getInstallationRepository(config, "open-inspect", "background-agents", {
        cacheStore,
      });

      expect(result).toEqual({
        id: 123,
        owner: "open-inspect",
        name: "background-agents",
        fullName: "open-inspect/background-agents",
        description: null,
        private: true,
        archived: false,
        defaultBranch: "main",
      });
    });

    it("rejects malformed single repository responses", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig("get-repo-invalid");
      await cacheInstallationToken(cacheStore, config);
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ...githubRepoResponse, owner: { login: 123 } }))
      );

      await expect(
        getInstallationRepository(config, "open-inspect", "background-agents", { cacheStore })
      ).rejects.toThrow("Failed to fetch repository: invalid response");
    });

    it("parses repository branch responses", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig("branches-valid");
      await cacheInstallationToken(cacheStore, config);
      fetchMock.mockResolvedValue(new Response(JSON.stringify([{ name: "main" }])));

      await expect(
        listRepositoryBranches(config, "open-inspect", "background-agents", { cacheStore })
      ).resolves.toEqual([{ name: "main" }]);
    });

    it("rejects malformed repository branch responses", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig("branches-invalid");
      await cacheInstallationToken(cacheStore, config);
      fetchMock.mockResolvedValue(new Response(JSON.stringify([{ protected: true }])));

      await expect(
        listRepositoryBranches(config, "open-inspect", "background-agents", { cacheStore })
      ).rejects.toThrow("Failed to list branches: invalid response");
    });
  });

  describe("listRepositoryBranches pagination", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const endpoint = "https://api.github.com/repos/acme/widgets/branches";
    const branchPage = (page: number, count = 100) =>
      Array.from({ length: count }, (_, index) => ({ name: `page-${page}-branch-${index}` }));
    const deferredResponse = () => {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };

    it("dispatches later pages concurrently and preserves page order on out-of-order completion", async () => {
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig("branches-concurrent");
      await cacheInstallationToken(cacheStore, config);
      const first = branchPage(1);
      const second = branchPage(2);
      const third = branchPage(3, 2);
      const secondResponse = deferredResponse();
      const thirdResponse = deferredResponse();
      const thirdBody = Response.json(third);
      const thirdJson = vi.spyOn(thirdBody, "json");
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected branch request"))
        .mockResolvedValueOnce(
          Response.json(first, {
            headers: {
              Link: `<${endpoint}?per_page=100&page=2>; rel="next", <${endpoint}?per_page=100&page=3>; rel="last"`,
            },
          })
        )
        .mockReturnValueOnce(secondResponse.promise)
        .mockReturnValueOnce(thirdResponse.promise);

      const result = listRepositoryBranches(config, "acme", "widgets", { cacheStore });
      try {
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
        thirdResponse.resolve(thirdBody);
        await vi.waitFor(() => expect(thirdJson).toHaveBeenCalledOnce());
        expect(await thirdJson.mock.results[0].value).toEqual(third);
      } finally {
        secondResponse.resolve(Response.json(second));
        thirdResponse.resolve(thirdBody);
        await result;
      }

      expect(await result).toEqual([...first, ...second, ...third]);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${endpoint}?per_page=100&page=1`,
        `${endpoint}?per_page=100&page=2`,
        `${endpoint}?per_page=100&page=3`,
      ]);
    });

    it("uses only the last page number, keeps the existing endpoint, and stops at a full last page", async () => {
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig("branches-link-endpoint");
      await cacheInstallationToken(cacheStore, config);
      const first = branchPage(1);
      const second = branchPage(2);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => Response.json([]))
        .mockResolvedValueOnce(
          Response.json(first, {
            headers: {
              Link: '<https://example.com/repos/acme/widgets/branches?per_page=1&page=2>; rel="last"; type="application/json", <https://example.com/repos/acme/widgets/branches?page=99>; rel="next"',
            },
          })
        )
        .mockResolvedValueOnce(Response.json(second));

      expect(
        await listRepositoryBranches(config, "acme", "widgets", {
          cacheStore,
          userAgent: "branch-test",
        })
      ).toEqual([...first, ...second]);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${endpoint}?per_page=100&page=1`,
        `${endpoint}?per_page=100&page=2`,
      ]);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init).toEqual({
          headers: {
            Authorization: "Bearer cached-token",
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "branch-test",
          },
          signal: expect.any(AbortSignal),
        });
      }
    });

    it.each([
      ["missing Link", undefined],
      ["no last relation", `<${endpoint}?page=3>; rel="next"`],
      ["invalid URL", '<not-a-url>; rel="last"'],
      ["missing page", `<${endpoint}?per_page=100>; rel="last"`],
      ["invalid page", `<${endpoint}?page=3oops>; rel="last"`],
      ["zero page", `<${endpoint}?page=0>; rel="last"`],
      ["negative page", `<${endpoint}?page=-3>; rel="last"`],
      ["fractional page", `<${endpoint}?page=3.5>; rel="last"`],
      ["unsafe page", `<${endpoint}?page=9007199254740992>; rel="last"`],
    ])("falls back to sequential pagination with %s", async (_label, link) => {
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig(`branches-fallback-${_label}`);
      await cacheInstallationToken(cacheStore, config);
      const first = branchPage(1);
      const second = branchPage(2);
      const third = branchPage(3, 1);
      const secondResponse = deferredResponse();
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected branch request"))
        .mockResolvedValueOnce(Response.json(first, { headers: link ? { Link: link } : {} }))
        .mockReturnValueOnce(secondResponse.promise)
        .mockResolvedValueOnce(Response.json(third));

      const result = listRepositoryBranches(config, "acme", "widgets", { cacheStore });
      try {
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
          `${endpoint}?per_page=100&page=1`,
          `${endpoint}?per_page=100&page=2`,
        ]);
      } finally {
        secondResponse.resolve(Response.json(second));
        await result;
      }

      expect(await result).toEqual([...first, ...second, ...third]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each([
      ["without Link", undefined, 100],
      ["with Link", `<${endpoint}?per_page=100&page=999>; rel="last"`, 100],
      ["with oversized pages", `<${endpoint}?per_page=100&page=999>; rel="last"`, 101],
    ])("caps pagination at five pages and 500 branches %s", async (_label, link, count) => {
      const cacheStore = new FakeCacheStore();
      const config = cachedTokenConfig(`branches-cap-${_label}`);
      await cacheInstallationToken(cacheStore, config);
      const pages = Array.from({ length: 5 }, (_, index) => branchPage(index + 1, count));
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        return Response.json(pages[page - 1] ?? [], {
          headers: page === 1 && link ? { Link: link } : {},
        });
      });

      expect(await listRepositoryBranches(config, "acme", "widgets", { cacheStore })).toEqual(
        pages.flat().slice(0, 500)
      );
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
        pages.map((_, index) => `${endpoint}?per_page=100&page=${index + 1}`)
      );
    });

    describe.each([
      ["concurrent", `<${endpoint}?per_page=100&page=3>; rel="last"`],
      ["sequential", undefined],
    ])("later-page failures during %s pagination", (_mode, link) => {
      it.each([
        [
          "HTTP failure",
          () => new Response("Unauthorized", { status: 401 }),
          "Failed to list branches: 401 Unauthorized",
        ],
        [
          "malformed branch data",
          () => Response.json([{ name: 42 }]),
          "Failed to list branches: invalid response",
        ],
        ["invalid JSON", () => new Response("not json"), SyntaxError],
      ])("rejects on %s rather than returning partial results", async (_label, response, error) => {
        const cacheStore = new FakeCacheStore();
        const config = cachedTokenConfig(`branches-failure-${_mode}-${_label}`);
        await cacheInstallationToken(cacheStore, config);
        const fetchMock = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValue(new Error("Unexpected branch request"))
          .mockResolvedValueOnce(
            Response.json(branchPage(1), { headers: link ? { Link: link } : {} })
          )
          .mockResolvedValueOnce(Response.json(branchPage(2)))
          .mockResolvedValueOnce(response());

        await expect(
          listRepositoryBranches(config, "acme", "widgets", { cacheStore })
        ).rejects.toThrow(error);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });
    });
  });
});
