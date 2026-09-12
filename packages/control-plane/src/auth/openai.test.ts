import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkOpenAIDeviceAuthorization,
  exchangeOpenAIAuthorizationCode,
  extractOpenAIAccountId,
  openAIAccessTokenLifetimeMs,
  OpenAIOAuthError,
  OpenAITokenRefreshError,
  refreshOpenAIToken,
  startOpenAIDeviceAuthorization,
} from "./openai";
import type { OpenAITokenResponse } from "./openai";

describe("openai", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("refreshOpenAIToken", () => {
    it("returns tokens on success", async () => {
      const mockTokens: OpenAITokenResponse = {
        id_token: "id.jwt.token",
        access_token: "acc_123",
        refresh_token: "rt_new",
        expires_in: 3600,
      };

      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockTokens)));

      const result = await refreshOpenAIToken("rt_old");

      expect(result).toEqual(mockTokens);
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://auth.openai.com/oauth/token");
      expect(init.method).toBe("POST");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(init.body).toContain("grant_type=refresh_token");
      expect(init.body).toContain("refresh_token=rt_old");
      expect(init.body).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    });

    it("returns tokens when optional expires_in is omitted", async () => {
      const mockTokens: OpenAITokenResponse = {
        id_token: "id.jwt.token",
        access_token: "acc_123",
        refresh_token: "rt_new",
      };

      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockTokens)));

      await expect(refreshOpenAIToken("rt_old")).resolves.toEqual(mockTokens);
    });

    it("throws OpenAITokenRefreshError on malformed success response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"access_token":"acc_123"}'));

      const err = await refreshOpenAIToken("rt_old").catch((e) => e);
      expect(err).toBeInstanceOf(OpenAITokenRefreshError);
      expect(err.status).toBe(200);
      expect(err).not.toHaveProperty("body");
    });

    it("throws OpenAITokenRefreshError on 401 without retaining the provider body", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 401 }));

      const err = await refreshOpenAIToken("rt_expired").catch((e) => e);
      expect(err).toBeInstanceOf(OpenAITokenRefreshError);
      expect(err.status).toBe(401);
      expect(err.errorCode).toBe("invalid_grant");
      expect(err).not.toHaveProperty("body");
    });

    it("throws OpenAITokenRefreshError on 500", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

      await expect(refreshOpenAIToken("rt_any")).rejects.toThrow(OpenAITokenRefreshError);
    });

    it("propagates network errors", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

      await expect(refreshOpenAIToken("rt_any")).rejects.toThrow("fetch failed");
    });
  });

  describe("device authorization", () => {
    it("sends the exact start request and validates the interval", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "3" })
          )
        );

      await expect(startOpenAIDeviceAuthorization()).resolves.toEqual({
        deviceAuthId: "device-1",
        userCode: "ABCD-EFGH",
        intervalMs: 3000,
      });
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
      expect(init).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Open-Inspect" },
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      });
    });

    it("accepts and strips extra provider response fields", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              device_auth_id: "device-1",
              user_code: "ABCD-EFGH",
              interval: 3,
              provider_metadata: "ignored",
            })
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              authorization_code: "authorization-secret",
              code_verifier: "verifier",
              provider_metadata: "ignored",
            })
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id_token: "id.jwt.token",
              access_token: "access",
              refresh_token: "refresh",
              provider_metadata: "ignored",
            })
          )
        );

      await expect(startOpenAIDeviceAuthorization()).resolves.toEqual({
        deviceAuthId: "device-1",
        userCode: "ABCD-EFGH",
        intervalMs: 3_000,
      });
      await expect(checkOpenAIDeviceAuthorization("device-1", "ABCD")).resolves.toEqual({
        status: "authorized",
        authorizationCode: "authorization-secret",
        codeVerifier: "verifier",
      });
      await expect(
        exchangeOpenAIAuthorizationCode("authorization-secret", "verifier")
      ).resolves.toEqual({
        id_token: "id.jwt.token",
        access_token: "access",
        refresh_token: "refresh",
      });
    });

    it.each([403, 404])("maps provider %s to pending", async (status) => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("pending", { status }));
      await expect(checkOpenAIDeviceAuthorization("device-1", "ABCD")).resolves.toEqual({
        status: "pending",
      });
    });

    it("returns server-only authorization material and uses the fixed token exchange", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              authorization_code: "authorization-secret",
              code_verifier: "verifier",
            })
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id_token: "id.jwt.token",
              access_token: "access",
              refresh_token: "refresh",
              expires_in: 3600,
            })
          )
        );

      await expect(checkOpenAIDeviceAuthorization("device-1", "ABCD")).resolves.toEqual({
        status: "authorized",
        authorizationCode: "authorization-secret",
        codeVerifier: "verifier",
      });
      await exchangeOpenAIAuthorizationCode("authorization-secret", "verifier");
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[1];
      expect(url).toBe("https://auth.openai.com/oauth/token");
      expect(new URLSearchParams(String(init?.body))).toEqual(
        new URLSearchParams({
          grant_type: "authorization_code",
          code: "authorization-secret",
          redirect_uri: "https://auth.openai.com/deviceauth/callback",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          code_verifier: "verifier",
        })
      );
    });

    it("accepts omitted ID tokens and numeric-string lifetimes", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "access.jwt.token",
            refresh_token: "refresh",
            expires_in: "7776000",
          })
        )
      );

      await expect(
        exchangeOpenAIAuthorizationCode("authorization-secret", "verifier")
      ).resolves.toEqual({
        access_token: "access.jwt.token",
        refresh_token: "refresh",
        expires_in: 7_776_000,
      });
      expect(openAIAccessTokenLifetimeMs(7_776_000)).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it.each([0, -1, 1.5])("rejects invalid token lifetime %s", async (expiresIn) => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id_token: "id.jwt.token",
            access_token: "access",
            refresh_token: "refresh",
            expires_in: expiresIn,
          })
        )
      );
      await expect(
        exchangeOpenAIAuthorizationCode("authorization-secret", "verifier")
      ).rejects.toThrow("invalid data");
    });

    it.each([0, 61, "1.5"])("rejects invalid polling interval %s", async (interval) => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ device_auth_id: "device", user_code: "ABCD", interval }))
        );
      await expect(startOpenAIDeviceAuthorization()).rejects.toThrow("invalid data");
    });

    it("bounds malformed and oversized responses without exposing bodies", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ user_code: "SECRET-CODE" })))
        .mockResolvedValueOnce(
          new Response("x", { headers: { "Content-Length": String(64 * 1024 + 1) } })
        );
      const malformed = await startOpenAIDeviceAuthorization().catch((error) => error);
      expect(malformed).toBeInstanceOf(OpenAIOAuthError);
      expect(malformed.message).not.toContain("SECRET-CODE");
      await expect(startOpenAIDeviceAuthorization()).rejects.toThrow("oversized response");
    });
  });

  describe("extractOpenAIAccountId", () => {
    function makeJwt(payload: Record<string, unknown>): string {
      const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const body = btoa(JSON.stringify(payload));
      return `${header}.${body}.sig`;
    }

    it("extracts chatgpt_account_id from id_token", () => {
      const tokens: OpenAITokenResponse = {
        id_token: makeJwt({ chatgpt_account_id: "acct_123" }),
        access_token: makeJwt({}),
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBe("acct_123");
    });

    it("extracts nested claim from id_token", () => {
      const tokens: OpenAITokenResponse = {
        id_token: makeJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_nested" },
        }),
        access_token: makeJwt({}),
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBe("acct_nested");
    });

    it("extracts organizations[0].id from access_token", () => {
      const tokens: OpenAITokenResponse = {
        access_token: makeJwt({ organizations: [{ id: "org_abc" }] }),
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBe("org_abc");
    });

    it("prefers id_token over access_token", () => {
      const tokens: OpenAITokenResponse = {
        id_token: makeJwt({ chatgpt_account_id: "from_id" }),
        access_token: makeJwt({ chatgpt_account_id: "from_access" }),
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBe("from_id");
    });

    it("falls back to access_token when id_token has no account", () => {
      const tokens: OpenAITokenResponse = {
        id_token: makeJwt({ sub: "user" }),
        access_token: makeJwt({ chatgpt_account_id: "from_access" }),
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBe("from_access");
    });

    it("returns undefined for tokens with no account claims", () => {
      const tokens: OpenAITokenResponse = {
        id_token: makeJwt({ sub: "user" }),
        access_token: makeJwt({ sub: "user" }),
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBeUndefined();
    });

    it("returns undefined for malformed tokens", () => {
      const tokens: OpenAITokenResponse = {
        id_token: "not-a-jwt",
        access_token: "also-bad",
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBeUndefined();
    });

    it("returns undefined for empty token strings", () => {
      const tokens: OpenAITokenResponse = {
        id_token: "",
        access_token: "",
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBeUndefined();
    });

    it("handles base64url-encoded JWT payloads with padding needed", () => {
      // Use a payload whose base64 length is not a multiple of 4 after stripping padding.
      // "ab" → base64 "YWI=" (4 chars with padding, 3 without) — requires restored padding.
      const payload = { chatgpt_account_id: "ab" };
      const header = btoa(JSON.stringify({ alg: "RS256" }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const body = btoa(JSON.stringify(payload))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const jwt = `${header}.${body}.sig`;

      const tokens: OpenAITokenResponse = {
        id_token: jwt,
        access_token: "",
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBe("ab");
    });

    it("rejects non-string account IDs", () => {
      const tokens: OpenAITokenResponse = {
        id_token: makeJwt({ chatgpt_account_id: 12345 }),
        access_token: makeJwt({}),
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBeUndefined();
    });

    it.each([
      ["object", { nested: "account" }],
      ["array", ["account"]],
      ["blank string", "   "],
    ])("rejects %s account IDs", (_label, accountId) => {
      const tokens: OpenAITokenResponse = {
        id_token: makeJwt({ chatgpt_account_id: accountId }),
        access_token: makeJwt({}),
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBeUndefined();
    });
  });
});
