import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicTokenError,
  exchangeAnthropicAuthorizationCode,
  refreshAnthropicToken,
} from "./anthropic";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Anthropic OAuth tokens", () => {
  it("exchanges browser PKCE completion data with the public Claude client", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 28_800,
        refresh_token_expires_in: 31_536_000,
        scope: "user:inference user:profile",
        token_type: "Bearer",
      })
    );

    await expect(
      exchangeAnthropicAuthorizationCode({
        authorizationCode: "code",
        codeVerifier: "v".repeat(43),
        state: "state",
      })
    ).resolves.toMatchObject({ access_token: "access", refresh_token: "refresh" });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: "authorization_code",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code: "code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      code_verifier: "v".repeat(43),
      state: "state",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("strips unknown metadata from successful token responses", async () => {
    const tokens = {
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 28_800,
    };
    const response = {
      ...tokens,
      account: { uuid: "account-id", email_address: "user@example.com" },
      organization: { uuid: "organization-id" },
      unexpected: true,
    };
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json(response));

    await expect(
      exchangeAnthropicAuthorizationCode({
        authorizationCode: "code",
        codeVerifier: "v".repeat(43),
        state: "state",
      })
    ).resolves.toEqual(tokens);
  });

  it("refreshes with JSON and accepts omitted refresh-token rotation", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ access_token: "next-access", expires_in: 3600 }));

    await expect(refreshAnthropicToken("old-refresh")).resolves.toEqual({
      access_token: "next-access",
      expires_in: 3600,
    });
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: "refresh_token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      refresh_token: "old-refresh",
    });
  });

  it.each([
    { access_token: "", refresh_token: "refresh" },
    { access_token: "access" },
    { access_token: "access", refresh_token: "refresh", expires_in: 0 },
  ])("rejects invalid initial responses: %o", async (body) => {
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json(body));

    await expect(
      exchangeAnthropicAuthorizationCode({
        authorizationCode: "code",
        codeVerifier: "v".repeat(43),
        state: "state",
      })
    ).rejects.toMatchObject({ reason: "invalid_response" });
  });

  it.each([
    [401, { error: "anything" }],
    [400, { error: "invalid_grant", error_description: "expired" }],
  ])("classifies status %s as unauthorized", async (status, body) => {
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json(body, { status }));

    await expect(refreshAnthropicToken("stale")).rejects.toMatchObject({
      status,
      reason: "unauthorized",
    });
  });

  it("classifies uncertain post-dispatch failures without retaining the response body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("upstream unavailable", { status: 503 }));

    const error = await refreshAnthropicToken("refresh").catch((cause) => cause);
    expect(error).toBeInstanceOf(AnthropicTokenError);
    expect(error).toMatchObject({ status: 503, reason: "other" });
    expect(error).not.toHaveProperty("body");
  });
});
