import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { getTokenMock } = vi.hoisted(() => ({
  getTokenMock: vi.fn(),
}));

vi.mock("next-auth/jwt", async () => {
  const actual = await vi.importActual<typeof import("next-auth/jwt")>("next-auth/jwt");
  return {
    ...actual,
    getToken: getTokenMock,
  };
});

describe("createBitbucketProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    getTokenMock.mockReset();
    process.env.SCM_PROVIDER = "bitbucket";
    process.env.BITBUCKET_CLIENT_ID = "bitbucket-client-id";
    process.env.BITBUCKET_CLIENT_SECRET = "bitbucket-client-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("fetches Bitbucket userinfo with bearer auth and enriches the profile with email", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uuid: "{user-123}",
            nickname: "octo-bb",
            display_name: "Octo Bitbucket",
            links: {
              avatar: {
                href: "https://avatar.example/user.png",
              },
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [
              {
                email: "octo@example.com",
                is_primary: true,
                is_confirmed: true,
              },
            ],
          }),
          { status: 200 }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const { createBitbucketProvider } = await import("./auth");
    const provider = createBitbucketProvider();

    if (typeof provider.userinfo === "string" || !provider.userinfo?.request) {
      throw new Error("Expected Bitbucket provider to define a userinfo request handler");
    }

    const profile = await provider.userinfo.request({
      tokens: { access_token: "access-token-123" },
      client: {} as never,
      provider: {
        ...provider,
        signinUrl: "http://localhost:3000/api/auth/signin/bitbucket",
        callbackUrl: "http://localhost:3000/api/auth/callback/bitbucket",
      } as never,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.bitbucket.org/2.0/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-token-123",
          Accept: "application/json",
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.bitbucket.org/2.0/user/emails",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-token-123",
          Accept: "application/json",
        }),
      })
    );
    expect(profile).toEqual(
      expect.objectContaining({
        uuid: "{user-123}",
        nickname: "octo-bb",
        display_name: "Octo Bitbucket",
        email: "octo@example.com",
        links: {
          avatar: {
            href: "https://avatar.example/user.png",
          },
        },
      })
    );
  });

  it("requests offline_access so refresh tokens are issued", async () => {
    const { createBitbucketProvider } = await import("./auth");
    const provider = createBitbucketProvider();

    if (typeof provider.authorization === "string") {
      throw new Error("Expected Bitbucket provider authorization config to be object-based");
    }

    expect(provider.authorization?.params).toEqual(
      expect.objectContaining({
        scope: expect.stringContaining("offline_access"),
      })
    );
  });

  it("refreshes expired Bitbucket JWT access tokens before reuse", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "refreshed-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 7200,
        }),
        { status: 200 }
      )
    );

    vi.stubGlobal("fetch", fetchMock);

    const { authOptions } = await import("./auth");
    const jwt = authOptions.callbacks?.jwt;
    if (!jwt) {
      throw new Error("Expected authOptions to define a jwt callback");
    }

    const refreshed = await jwt(
      {
        token: {
          accessToken: "expired-access-token",
          refreshToken: "refresh-token-123",
          accessTokenExpiresAt: Date.now() - 1_000,
          providerUserId: "bb-user-1",
          providerLogin: "octo-bb",
        },
        account: null,
        profile: undefined,
        user: undefined,
        trigger: "update",
        session: undefined,
        isNewUser: false,
      } as never
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bitbucket.org/site/oauth2/access_token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("bitbucket-client-id:bitbucket-client-secret").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body: expect.any(URLSearchParams),
      })
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "refresh-token-123",
      })
    );
    expect(refreshed).toEqual(
      expect.objectContaining({
        accessToken: "refreshed-access-token",
        refreshToken: "rotated-refresh-token",
        providerUserId: "bb-user-1",
        providerLogin: "octo-bb",
      })
    );
    expect(typeof refreshed.accessTokenExpiresAt).toBe("number");
    expect(refreshed.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshes Bitbucket tokens when repo routes read SCM auth from the request", async () => {
    getTokenMock.mockResolvedValue({
      accessToken: "expired-access-token",
      refreshToken: "refresh-token-123",
      accessTokenExpiresAt: Date.now() - 1_000,
      providerUserId: "bb-user-1",
      providerLogin: "octo-bb",
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "refreshed-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 7200,
        }),
        { status: 200 }
      )
    );

    vi.stubGlobal("fetch", fetchMock);

    const { getRequestScmTokenState } = await import("./auth");
    const tokenState = await getRequestScmTokenState(
      new NextRequest("https://example.com/api/repos")
    );

    expect(getTokenMock).toHaveBeenCalled();
    expect(tokenState).toEqual(
      expect.objectContaining({
        accessToken: "refreshed-access-token",
        refreshToken: "rotated-refresh-token",
      })
    );
    expect(tokenState.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });
});
