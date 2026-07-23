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
import type { CacheStore } from "@open-inspect/shared";

class FakeCacheStore implements CacheStore {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null>;
  async get<T>(key: string, type: "json"): Promise<T | null>;
  async get<T>(key: string, type?: "json"): Promise<string | T | null> {
    const value = this.store.get(key);
    if (value == null) {
      return null;
    }
    if (type !== "json") {
      return value;
    }
    return JSON.parse(value) as T;
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
    `github:installation-token:v1:${config.appId}:${config.installationId}`,
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
        `github:installation-token:v1:${config.appId}:${config.installationId}`,
        JSON.stringify({
          token: "token-from-kv",
          expiresAtEpochMs:
            Date.now() + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS + INSTALLATION_TOKEN_MIN_REMAINING_MS,
          cachedAtEpochMs: Date.now(),
        })
      );

      const token = await getCachedInstallationToken(config, {
        cacheStore,
      });

      expect(token).toBe("token-from-kv");
      expect(fetchMock).not.toHaveBeenCalled();
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
        `github:installation-token:v1:${config.appId}:${config.installationId}`,
        JSON.stringify({
          token: "tok-with-expiry",
          expiresAtEpochMs,
          cachedAtEpochMs: Date.now(),
        })
      );

      const result = await getCachedInstallationTokenWithExpiry(config, { cacheStore });

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
        `github:installation-token:v1:${config.appId}:${config.installationId}`,
        JSON.stringify({
          token: "shared-token",
          expiresAtEpochMs:
            Date.now() + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS + INSTALLATION_TOKEN_MIN_REMAINING_MS,
          cachedAtEpochMs: Date.now(),
        })
      );

      const plain = await getCachedInstallationToken(config, { cacheStore });
      const withExpiry = await getCachedInstallationTokenWithExpiry(config, { cacheStore });

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
        { forceRefresh: true }
      );

      expect(result).toEqual({ token: "fresh-token", expiresAtEpochMs: Date.parse(expiresAt) });
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
          { forceRefresh: true }
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
          { forceRefresh: true }
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
          { forceRefresh: true }
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
});
