import { describe, expect, it, vi } from "vitest";
import { GitHubOAuthProvider } from "./github";

describe("GitHubOAuthProvider", () => {
  const config = {
    clientId: "github-client",
    clientSecret: "github-secret",
    callbackUri: "https://cp.example.com/oauth/callback/github",
    issuer: "https://github.com",
    userAgent: "Open Inspect Test",
  };

  it("rejects a non-canonical GitHub issuer", () => {
    expect(
      () =>
        new GitHubOAuthProvider({
          ...config,
          issuer: "https://github.com.attacker.example",
        })
    ).toThrow(expect.objectContaining({ failure: "invalid_configuration" }));
  });

  it("creates a GitHub App authorization URL bound to state and PKCE without classic scopes", async () => {
    const provider = new GitHubOAuthProvider(config);

    const authorizationUrl = await provider.createAuthorizationUrl({
      state: "state-value",
      codeChallenge: "a".repeat(43),
    });

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://github.com/login/oauth/authorize"
    );
    expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
      client_id: "github-client",
      redirect_uri: "https://cp.example.com/oauth/callback/github",
      state: "state-value",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    expect(authorizationUrl.searchParams.has("scope")).toBe(false);
  });

  it("exchanges the code with PKCE and returns validated identity and credential evidence", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ghu-access",
          token_type: "bearer",
          expires_in: 28_800,
          refresh_token: "ghr-refresh",
          refresh_token_expires_in: 15_552_000,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 583_231,
          login: "octocat",
          name: "The Octocat",
          avatar_url: "https://avatars.example/octocat",
        })
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            email: "Secondary@Example.com",
            primary: false,
            verified: true,
            visibility: null,
          },
          {
            email: "Primary@Example.com",
            primary: true,
            verified: true,
            visibility: "private",
          },
          {
            email: "PRIMARY@example.com",
            primary: false,
            verified: true,
            visibility: null,
          },
          {
            email: "unverified@example.com",
            primary: false,
            verified: false,
            visibility: null,
          },
        ])
      );
    const now = 1_752_000_000_000;
    const provider = new GitHubOAuthProvider(config, { fetch, clock: { now: () => now } });

    await expect(
      provider.exchangeAuthorizationCode({
        code: "github-code",
        codeVerifier: "v".repeat(43),
      })
    ).resolves.toEqual({
      identity: {
        provider: "github",
        issuer: "https://github.com",
        subject: "583231",
        login: "octocat",
        displayName: "The Octocat",
        avatarUrl: "https://avatars.example/octocat",
        verifiedEmails: ["secondary@example.com", "primary@example.com"],
        primaryEmail: "primary@example.com",
      },
      credential: {
        kind: "refreshable",
        accessToken: "ghu-access",
        accessExpiresAt: now + 28_800_000,
        refreshToken: "ghr-refresh",
        refreshExpiresAt: now + 15_552_000_000,
      },
    });

    const tokenRequest = fetch.mock.calls[0];
    expect(String(tokenRequest[0])).toBe("https://github.com/login/oauth/access_token");
    expect(tokenRequest[1]).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    expect(Object.fromEntries(new URLSearchParams(String(tokenRequest[1]?.body)))).toEqual({
      client_id: "github-client",
      client_secret: "github-secret",
      code: "github-code",
      redirect_uri: "https://cp.example.com/oauth/callback/github",
      code_verifier: "v".repeat(43),
    });
  });

  it("paginates GitHub emails to exhaustion so later verified evidence is not missed", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      email: `unverified-${index}@example.com`,
      primary: false,
      verified: false,
      visibility: null,
    }));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ghu-access",
          token_type: "bearer",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 583_231,
          login: "octocat",
          name: null,
          avatar_url: null,
        })
      )
      .mockResolvedValueOnce(
        Response.json(firstPage, {
          headers: {
            Link: '<https://api.github.com/user/emails?per_page=100&page=2>; rel="next"',
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            email: "later-page@example.com",
            primary: true,
            verified: true,
            visibility: null,
          },
        ])
      );
    const provider = new GitHubOAuthProvider(config, { fetch });

    const result = await provider.exchangeAuthorizationCode({
      code: "github-code",
      codeVerifier: "v".repeat(43),
    });

    expect(result.identity.verifiedEmails).toEqual(["later-page@example.com"]);
    expect(result.identity.primaryEmail).toBe("later-page@example.com");
    expect(String(fetch.mock.calls[3][0])).toBe(
      "https://api.github.com/user/emails?per_page=100&page=2"
    );
  });

  it("fails closed when GitHub email pagination metadata is malformed", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ghu-access",
          token_type: "bearer",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 583_231,
          login: "octocat",
        })
      )
      .mockResolvedValueOnce(
        Response.json([], {
          headers: { Link: "this is not a valid Link header" },
        })
      );
    const provider = new GitHubOAuthProvider(config, { fetch });

    await expect(
      provider.exchangeAuthorizationCode({
        code: "github-code",
        codeVerifier: "v".repeat(43),
      })
    ).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
  });

  it("maps a malformed GitHub email pagination URL to a bounded provider error", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ghu-access",
          token_type: "bearer",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 583_231,
          login: "octocat",
        })
      )
      .mockResolvedValueOnce(
        Response.json([], {
          headers: { Link: '<not a url>; rel="next"' },
        })
      );
    const provider = new GitHubOAuthProvider(config, { fetch });

    await expect(
      provider.exchangeAuthorizationCode({
        code: "github-code",
        codeVerifier: "v".repeat(43),
      })
    ).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
  });

  it("fails closed when GitHub repeats an email page", async () => {
    const repeatedPage = "https://api.github.com/user/emails?per_page=100&page=1";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ghu-access",
          token_type: "bearer",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 583_231,
          login: "octocat",
        })
      )
      .mockResolvedValueOnce(
        Response.json([], {
          headers: { Link: `<${repeatedPage}>; rel="next"` },
        })
      );
    const provider = new GitHubOAuthProvider(config, { fetch });

    await expect(
      provider.exchangeAuthorizationCode({
        code: "github-code",
        codeVerifier: "v".repeat(43),
      })
    ).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
