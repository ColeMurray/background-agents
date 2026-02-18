import { describe, it, expect, vi } from "vitest";
import {
  isGitHubAppConfigured,
  getGitHubAppConfig,
  getCachedInstallationToken,
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

  describe("getCachedInstallationToken", () => {
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
          expiresAtEpochMs: Date.now() + 55 * 60 * 1000,
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
