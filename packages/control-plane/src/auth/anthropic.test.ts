import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_OAUTH_REDIRECT_URI,
  ANTHROPIC_OAUTH_TOKEN_URL,
  ANTHROPIC_SETUP_TOKEN_LIFETIME_MS,
  AnthropicTokenExchangeError,
  exchangeAnthropicAuthorizationCode,
  parsePastedAuthorizationCode,
  startAnthropicAuthorization,
} from "./anthropic";

const NOW = 1_700_000_000_000;
const EXCHANGE_INPUT = {
  code: "pasted-code",
  expectedState: "state-1",
  codeVerifier: "verifier-1",
};

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function tokenResponse(body: Record<string, unknown>, status = 200): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
}

async function failure(fetchImpl: typeof fetch): Promise<AnthropicTokenExchangeError> {
  const error = await exchangeAnthropicAuthorizationCode(EXCHANGE_INPUT, fetchImpl, NOW).catch(
    (cause: unknown) => cause
  );
  expect(error).toBeInstanceOf(AnthropicTokenExchangeError);
  return error as AnthropicTokenExchangeError;
}

describe("startAnthropicAuthorization", () => {
  it("builds the paste-back consent URL with an S256 challenge over a private verifier", async () => {
    const request = await startAnthropicAuthorization();
    const url = new URL(request.authorizationUrl);

    expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code: "true",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      response_type: "code",
      redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
      scope: "user:inference",
      code_challenge: base64Url(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.codeVerifier))
      ),
      code_challenge_method: "S256",
      state: request.state,
    });
    expect(request.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.authorizationUrl).not.toContain(request.codeVerifier);
  });

  it("uses fresh entropy for every request", async () => {
    const [first, second] = await Promise.all([
      startAnthropicAuthorization(),
      startAnthropicAuthorization(),
    ]);
    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });
});

describe("parsePastedAuthorizationCode", () => {
  it.each([
    ["abc#xyz", { code: "abc", state: "xyz" }],
    ["  abc#xyz\n", { code: "abc", state: "xyz" }],
    ["abc", { code: "abc" }],
    ["abc#", { code: "abc", state: "" }],
  ])("splits %j into code and state", (pasted, expected) => {
    expect(parsePastedAuthorizationCode(pasted)).toEqual(expected);
  });
});

describe("exchangeAnthropicAuthorizationCode", () => {
  it("posts the PKCE exchange and returns an inference token with a relative expiry", async () => {
    const fetchImpl = tokenResponse({
      access_token: "sk-ant-oat01-token",
      refresh_token: "must-not-be-returned",
      expires_in: 3_600,
      scope: "user:inference",
    });

    const result = await exchangeAnthropicAuthorizationCode(
      { ...EXCHANGE_INPUT, pastedState: "state-1" },
      fetchImpl,
      NOW
    );

    expect(result).toEqual({
      accessToken: "sk-ant-oat01-token",
      expiresAt: NOW + 3_600_000,
      scope: "user:inference",
      tokenUuid: undefined,
      account: undefined,
      organization: undefined,
    });
    expect(Object.keys(result)).not.toContain("refreshToken");
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe(ANTHROPIC_OAUTH_TOKEN_URL);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: "authorization_code",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code: "pasted-code",
      state: "state-1",
      code_verifier: "verifier-1",
      redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
      expires_in: 31_536_000,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Cloudflare in front of the token endpoint bans anonymous client signatures.
    expect(new Headers(init?.headers).get("User-Agent")).toBe("claude-cli/2.1.259 (external, cli)");
  });

  it("keeps the granting account, organization and token id the real response carries", async () => {
    // Shape observed from platform.claude.com on 2026-09-10.
    const fetchImpl = tokenResponse({
      token_type: "Bearer",
      access_token: "sk-ant-oat01-token",
      expires_in: 31_536_000,
      refresh_token: "sk-ant-ort01-never-stored",
      refresh_token_expires_in: 2_511_418,
      scope: "user:inference",
      token_uuid: "11111111-2222-4333-8444-555555555555",
      organization: { uuid: "org-uuid", name: "Owner's Organization" },
      account: { uuid: "account-uuid", email_address: "owner@example.com" },
    });

    const result = await exchangeAnthropicAuthorizationCode(EXCHANGE_INPUT, fetchImpl, NOW);

    expect(result).toEqual({
      accessToken: "sk-ant-oat01-token",
      expiresAt: NOW + 31_536_000_000,
      scope: "user:inference",
      tokenUuid: "11111111-2222-4333-8444-555555555555",
      account: { uuid: "account-uuid", email: "owner@example.com" },
      organization: { uuid: "org-uuid", name: "Owner's Organization" },
    });
    expect(JSON.stringify(result)).not.toContain("ort01");
  });

  it("ignores identity objects without a uuid", async () => {
    const fetchImpl = tokenResponse({
      access_token: "sk-ant-oat01-token",
      scope: "user:inference",
      account: { email_address: "owner@example.com" },
      organization: "not-an-object",
      token_uuid: "",
    });
    const result = await exchangeAnthropicAuthorizationCode(EXCHANGE_INPUT, fetchImpl, NOW);
    expect(result.account).toBeUndefined();
    expect(result.organization).toBeUndefined();
    expect(result.tokenUuid).toBeUndefined();
  });

  it.each([
    ["seconds", Math.floor((NOW + 86_400_000) / 1000), NOW + 86_400_000],
    ["milliseconds", NOW + 86_400_000, NOW + 86_400_000],
  ])("accepts an absolute expires_at in %s", async (_unit, expiresAt, expected) => {
    const fetchImpl = tokenResponse({
      access_token: "sk-ant-oat01-token",
      expires_at: expiresAt,
      scope: "user:inference",
    });

    await expect(
      exchangeAnthropicAuthorizationCode(EXCHANGE_INPUT, fetchImpl, NOW)
    ).resolves.toMatchObject({ expiresAt: expected });
  });

  it("falls back to the documented one-year lifetime without an expiry", async () => {
    const fetchImpl = tokenResponse({
      access_token: "sk-ant-oat01-token",
      scope: "user:inference",
    });

    await expect(
      exchangeAnthropicAuthorizationCode(EXCHANGE_INPUT, fetchImpl, NOW)
    ).resolves.toMatchObject({ expiresAt: NOW + ANTHROPIC_SETUP_TOKEN_LIFETIME_MS });
  });

  it("accepts a broader scope grant that includes inference", async () => {
    const fetchImpl = tokenResponse({
      access_token: "sk-ant-oat01-token",
      scope: "user:profile user:inference",
    });

    await expect(
      exchangeAnthropicAuthorizationCode(EXCHANGE_INPUT, fetchImpl, NOW)
    ).resolves.toMatchObject({ scope: "user:profile user:inference" });
  });

  it("rejects a pasted state that belongs to another attempt before calling the provider", async () => {
    const fetchImpl = tokenResponse({ access_token: "sk-ant-oat01-token" });

    const error = await exchangeAnthropicAuthorizationCode(
      { ...EXCHANGE_INPUT, pastedState: "state-2" },
      fetchImpl,
      NOW
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ reason: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies a missing access token as a malformed response", async () => {
    const error = await failure(tokenResponse({ scope: "user:inference" }));
    expect(error.reason).toBe("malformed_response");
  });

  it("classifies a token without the inference scope as a scope mismatch", async () => {
    const error = await failure(
      tokenResponse({ access_token: "sk-ant-oat01-token", scope: "user:profile" })
    );
    expect(error.reason).toBe("scope_mismatch");
    expect(error.message).toContain("user:profile");
  });

  it("classifies invalid_grant with the provider's description", async () => {
    const error = await failure(
      tokenResponse(
        { error: "invalid_grant", error_description: "Authorization code already used" },
        400
      )
    );
    expect(error).toMatchObject({
      reason: "invalid_grant",
      message: "Authorization code already used",
    });
  });

  it("classifies other 4xx errors as invalid requests", async () => {
    const error = await failure(tokenResponse({ error: "invalid_client" }, 401));
    expect(error).toMatchObject({ reason: "invalid_request", message: "HTTP 401" });
  });

  it("classifies a 429 as rate limited", async () => {
    const error = await failure(
      tokenResponse({ error: "rate_limit_error", error_description: "Slow down" }, 429)
    );
    expect(error).toMatchObject({ reason: "rate_limited", message: "Slow down" });
  });

  it("classifies 5xx responses as server errors", async () => {
    const error = await failure(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("upstream down", { status: 503 }))
    );
    expect(error).toMatchObject({ reason: "server_error", message: "HTTP 503" });
  });

  it("classifies a failed fetch as a network error with its cause", async () => {
    const cause = new TypeError("fetch failed");
    const error = await failure(vi.fn<typeof fetch>().mockRejectedValue(cause));
    expect(error.reason).toBe("network");
    expect(error.cause).toBe(cause);
  });
});
