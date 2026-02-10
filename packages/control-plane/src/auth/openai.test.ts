import { describe, it, expect, vi, afterEach } from "vitest";
import { refreshOpenAIToken, extractOpenAIAccountId, OpenAITokenRefreshError } from "./openai";
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

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokens),
      } as unknown as Response);

      const result = await refreshOpenAIToken("rt_old");

      expect(result).toEqual(mockTokens);
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://auth.openai.com/oauth/token");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(init.body).toContain("grant_type=refresh_token");
      expect(init.body).toContain("refresh_token=rt_old");
      expect(init.body).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    });

    it("throws OpenAITokenRefreshError on 401 with status and body", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":"invalid_grant"}'),
      } as unknown as Response);

      const err = await refreshOpenAIToken("rt_expired").catch((e) => e);
      expect(err).toBeInstanceOf(OpenAITokenRefreshError);
      expect(err.status).toBe(401);
      expect(err.body).toBe('{"error":"invalid_grant"}');
    });

    it("throws OpenAITokenRefreshError on 500", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as unknown as Response);

      await expect(refreshOpenAIToken("rt_any")).rejects.toThrow(OpenAITokenRefreshError);
    });

    it("propagates network errors", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

      await expect(refreshOpenAIToken("rt_any")).rejects.toThrow("fetch failed");
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
        id_token: makeJwt({}),
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

    it("converts numeric account ID to string", () => {
      const tokens: OpenAITokenResponse = {
        id_token: makeJwt({ chatgpt_account_id: 12345 }),
        access_token: makeJwt({}),
        refresh_token: "rt",
      };

      expect(extractOpenAIAccountId(tokens)).toBe("12345");
    });
  });
});
