import { describe, it, expect } from "vitest";
import { isGitHubAppConfigured, getGitHubAppConfig } from "./github-app";

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
});
