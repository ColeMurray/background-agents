import { describe, expect, it, vi, afterEach } from "vitest";
import { exchangeCodeForToken, refreshAccessToken } from "./github";
import type { GitHubOAuthConfig } from "./github";
import type { GitHubTokenResponse } from "../types";

describe("github auth", () => {
  const originalFetch = globalThis.fetch;
  const config: GitHubOAuthConfig = {
    clientId: "client-id",
    clientSecret: "client-secret",
    encryptionKey: "unused",
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("exchangeCodeForToken", () => {
    it("parses a valid token response", async () => {
      const tokenResponse: GitHubTokenResponse = {
        access_token: "gho_token",
        token_type: "bearer",
        scope: "repo,user",
        refresh_token: "ghr_refresh",
        expires_in: 28800,
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve(tokenResponse),
      } as unknown as Response);

      await expect(exchangeCodeForToken("code", config)).resolves.toEqual(tokenResponse);
    });

    it("parses a valid token response with optional fields omitted", async () => {
      const tokenResponse: GitHubTokenResponse = {
        access_token: "gho_token",
        token_type: "bearer",
        scope: "repo",
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve(tokenResponse),
      } as unknown as Response);

      await expect(exchangeCodeForToken("code", config)).resolves.toEqual(tokenResponse);
    });

    it("rejects a malformed token response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ access_token: "gho_token", token_type: "bearer" }),
      } as unknown as Response);

      await expect(exchangeCodeForToken("code", config)).rejects.toThrow(
        "Invalid GitHub token response"
      );
    });

    it("preserves GitHub OAuth error handling", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            error: "bad_verification_code",
            error_description: "The code passed is incorrect or expired.",
          }),
      } as unknown as Response);

      await expect(exchangeCodeForToken("code", config)).rejects.toThrow(
        "The code passed is incorrect or expired."
      );
    });
  });

  describe("refreshAccessToken", () => {
    it("parses a valid refresh response", async () => {
      const tokenResponse: GitHubTokenResponse = {
        access_token: "gho_new",
        token_type: "bearer",
        scope: "repo,user",
        refresh_token: "ghr_new",
        expires_in: 28800,
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve(tokenResponse),
      } as unknown as Response);

      await expect(refreshAccessToken("old-refresh", config)).resolves.toEqual(tokenResponse);
    });

    it("rejects a malformed refresh response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ access_token: "gho_new", token_type: "bearer" }),
      } as unknown as Response);

      await expect(refreshAccessToken("old-refresh", config)).rejects.toThrow(
        "Invalid GitHub token response"
      );
    });
  });
});
