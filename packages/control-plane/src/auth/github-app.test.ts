import { afterEach, describe, it, expect, vi } from "vitest";
import {
  isGitHubAppConfigured,
  getGitHubAppConfig,
  getAllGitHubAppConfigs,
  getCachedInstallationToken,
  INSTALLATION_TOKEN_CACHE_MAX_AGE_MS,
  INSTALLATION_TOKEN_MIN_REMAINING_MS,
} from "./github-app";

class FakeKvNamespace {
  private readonly store = new Map<string, string>();

  async get<T>(key: string, type?: "text" | "json"): Promise<T | string | null> {
    const value = this.store.get(key);
    if (value == null) {
      return null;
    }
    if (type === "json") {
      return JSON.parse(value) as T;
    }
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

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

  describe("getGitHubAppConfig with comma-separated IDs", () => {
    const baseEnv = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "key",
    };

    it("returns the first installation ID when comma-separated", () => {
      const config = getGitHubAppConfig({
        ...baseEnv,
        GITHUB_APP_INSTALLATION_ID: "111,222",
      });
      expect(config?.installationId).toBe("111");
    });

    it("trims whitespace from the first ID", () => {
      const config = getGitHubAppConfig({
        ...baseEnv,
        GITHUB_APP_INSTALLATION_ID: " 111 , 222 ",
      });
      expect(config?.installationId).toBe("111");
    });

    it("returns null when first ID is empty (trailing comma)", () => {
      const config = getGitHubAppConfig({
        ...baseEnv,
        GITHUB_APP_INSTALLATION_ID: ",222",
      });
      expect(config).toBeNull();
    });

    it("returns null when all IDs are whitespace", () => {
      const config = getGitHubAppConfig({
        ...baseEnv,
        GITHUB_APP_INSTALLATION_ID: " , , ",
      });
      expect(config).toBeNull();
    });
  });

  describe("getAllGitHubAppConfigs", () => {
    const baseEnv = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "key",
    };

    it("returns one config per installation ID", () => {
      const configs = getAllGitHubAppConfigs({
        ...baseEnv,
        GITHUB_APP_INSTALLATION_ID: "111,222",
      });
      expect(configs).toHaveLength(2);
      expect(configs[0].installationId).toBe("111");
      expect(configs[1].installationId).toBe("222");
    });

    it("trims whitespace from IDs", () => {
      const configs = getAllGitHubAppConfigs({
        ...baseEnv,
        GITHUB_APP_INSTALLATION_ID: " 111 , 222 ",
      });
      expect(configs[0].installationId).toBe("111");
      expect(configs[1].installationId).toBe("222");
    });

    it("filters out empty IDs from trailing commas", () => {
      const configs = getAllGitHubAppConfigs({
        ...baseEnv,
        GITHUB_APP_INSTALLATION_ID: "111,,222,",
      });
      expect(configs).toHaveLength(2);
      expect(configs[0].installationId).toBe("111");
      expect(configs[1].installationId).toBe("222");
    });

    it("returns empty array for whitespace-only IDs", () => {
      const configs = getAllGitHubAppConfigs({
        ...baseEnv,
        GITHUB_APP_INSTALLATION_ID: " , , ",
      });
      expect(configs).toHaveLength(0);
    });

    it("returns empty array when not configured", () => {
      expect(getAllGitHubAppConfigs({})).toEqual([]);
    });

    it("handles single ID without commas", () => {
      const configs = getAllGitHubAppConfigs({
        ...baseEnv,
        GITHUB_APP_INSTALLATION_ID: "111",
      });
      expect(configs).toHaveLength(1);
      expect(configs[0].installationId).toBe("111");
    });
  });

  describe("getCachedInstallationToken", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("reads valid token from KV cache", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const kv = new FakeKvNamespace();

      const config = {
        appId: `app-kv-${Date.now()}`,
        privateKey: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
        installationId: "installation-2",
      };

      await kv.put(
        `github:installation-token:v1:${config.appId}:${config.installationId}`,
        JSON.stringify({
          token: "token-from-kv",
          expiresAtEpochMs:
            Date.now() + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS + INSTALLATION_TOKEN_MIN_REMAINING_MS,
          cachedAtEpochMs: Date.now(),
        })
      );

      const token = await getCachedInstallationToken(config, {
        REPOS_CACHE: kv as unknown as KVNamespace,
      });

      expect(token).toBe("token-from-kv");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
