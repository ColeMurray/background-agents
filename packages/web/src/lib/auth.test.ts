import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, NextAuthOptions, Profile, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { AccessControlConfig } from "./access-control";
import {
  applyJwtClaims,
  applySessionUser,
  getStaticSignInReason,
  getVerifiedPrimaryGitHubEmail,
} from "./auth";

vi.mock("@open-inspect/shared", () => ({
  DEFAULT_APP_NAME: "Open-Inspect",
}));

vi.mock("next-auth/providers/github", () => ({
  default: (config: unknown) => ({
    id: "github",
    type: "oauth",
    options: config,
  }),
}));

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetAuthEnv();
});

function cfg(overrides: Partial<AccessControlConfig> = {}): AccessControlConfig {
  return {
    allowedDomains: [],
    allowedUsers: [],
    allowedEmails: [],
    unsafeAllowAllUsers: false,
    ...overrides,
  };
}

describe("buildGitHubOAuthScope", () => {
  it("requests base scopes when organization access is disabled", async () => {
    const { BASE_GITHUB_OAUTH_SCOPE, buildGitHubOAuthScope } = await importAuthModule();

    expect(buildGitHubOAuthScope([])).toBe(BASE_GITHUB_OAUTH_SCOPE);
  });

  it("requests read:org only when organization access is configured", async () => {
    const { BASE_GITHUB_OAUTH_SCOPE, buildGitHubOAuthScope } = await importAuthModule();

    expect(buildGitHubOAuthScope(["acme"])).toBe(`${BASE_GITHUB_OAUTH_SCOPE} read:org`);
  });
});

describe("GitHub provider scope", () => {
  it("omits read:org when organization access is disabled", async () => {
    const { authOptions, BASE_GITHUB_OAUTH_SCOPE } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "",
    });

    expect(getGitHubProviderScope(authOptions)).toBe(BASE_GITHUB_OAUTH_SCOPE);
  });

  it("includes read:org when organization access is configured", async () => {
    const { authOptions, BASE_GITHUB_OAUTH_SCOPE } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
    });

    expect(getGitHubProviderScope(authOptions)).toBe(`${BASE_GITHUB_OAUTH_SCOPE} read:org`);
  });
});

describe("authOptions signIn", () => {
  it("logs static allow decisions without sensitive token data", async () => {
    const { authOptions } = await importAuthModule({
      ALLOWED_USERS: "alice",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      getSignIn(authOptions)({
        account: { access_token: "secret-token" },
        profile: { login: "Alice" },
        user: { email: "alice@example.com" },
      } as never)
    ).resolves.toBe(true);

    expect(info).toHaveBeenCalledWith("[auth] sign-in decision", {
      login: "Alice",
      decision: "allow",
      reason: "username_allowlist",
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret-token");
  });

  it("checks configured organization membership with the OAuth access token", async () => {
    const { authOptions } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
      NEXT_PUBLIC_APP_NAME: "Test App",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ state: "active" }))
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getSignIn(authOptions)({
        account: { access_token: "oauth-token" },
        profile: { login: "member" },
        user: { email: "member@example.com" },
      } as never)
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/user/memberships/orgs/acme",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-token",
          "User-Agent": "Test App",
        }) as HeadersInit,
      })
    );
    expect(info).toHaveBeenCalledWith("[auth] sign-in decision", {
      login: "member",
      decision: "allow",
      reason: "org_membership",
    });
  });

  it("denies organization access when the OAuth access token is missing", async () => {
    const { authOptions } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getSignIn(authOptions)({
        account: {},
        profile: { login: "member" },
        user: { email: "member@example.com" },
      } as never)
    ).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[github-org-access] membership check skipped", {
      reason: "missing_access_token",
      organizationCount: 1,
    });
    expect(info).toHaveBeenCalledWith("[auth] sign-in decision", {
      login: "member",
      decision: "deny",
      reason: "org_membership_unavailable",
    });
  });

  it.each([
    ["404 response", () => new Response("Not Found", { status: 404 })],
    ["pending membership", () => new Response(JSON.stringify({ state: "pending" }))],
  ])("denies organization access for %s", async (_label, responseFactory) => {
    const { authOptions } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => responseFactory()) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getSignIn(authOptions)({
        account: { access_token: "oauth-token" },
        profile: { login: "member" },
        user: { email: "member@example.com" },
      } as never)
    ).resolves.toBe(false);
  });

  it.each([
    ["429 response", () => new Response("Rate Limited", { status: 429 })],
    ["server error", () => new Response("Server Error", { status: 500 })],
    [
      "network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["malformed JSON", () => new Response("not-json")],
  ])("reports organization verification unavailable for %s", async (_label, responseFactory) => {
    const { authOptions } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => responseFactory()) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getSignIn(authOptions)({
        account: { access_token: "oauth-token" },
        profile: { login: "member" },
        user: { email: "member@example.com" },
      } as never)
    ).resolves.toBe(false);

    expect(info).toHaveBeenCalledWith("[auth] sign-in decision", {
      login: "member",
      decision: "deny",
      reason: "org_membership_unavailable",
    });
  });

  it("does not let unsafe open access bypass configured org allowlists", async () => {
    const { authOptions } = await importAuthModule({
      ALLOWED_GITHUB_ORGS: "acme",
      UNSAFE_ALLOW_ALL_USERS: "true",
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      getSignIn(authOptions)({
        account: { access_token: "oauth-token" },
        profile: { login: "outsider" },
        user: { email: "outsider@example.com" },
      } as never)
    ).resolves.toBe(false);
  });
});

describe("getVerifiedPrimaryGitHubEmail", () => {
  it("returns the verified primary GitHub email", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { email: "other@example.com", primary: false, verified: true, visibility: "private" },
          { email: "user@company.com", primary: true, verified: true, visibility: "private" },
        ])
      )
    );

    await expect(getVerifiedPrimaryGitHubEmail("token")).resolves.toBe("user@company.com");
  });

  it("rejects an unverified primary GitHub email", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { email: "user@company.com", primary: true, verified: false, visibility: "private" },
        ])
      )
    );

    await expect(getVerifiedPrimaryGitHubEmail("token")).resolves.toBeNull();
  });

  it("returns null when GitHub email lookup fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));

    await expect(getVerifiedPrimaryGitHubEmail("token")).resolves.toBeNull();
  });
});

describe("getStaticSignInReason", () => {
  describe("Google", () => {
    const config = cfg({ allowedEmails: ["pm@gmail.com"] });

    it("denies an unverified email (null) before any allowlist match", () => {
      expect(
        getStaticSignInReason({
          provider: "google",
          profile: { email_verified: false } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBeNull();
    });

    it('denies an unverified email when email_verified is the string "false"', () => {
      expect(
        getStaticSignInReason({
          provider: "google",
          profile: { email_verified: "false" } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBeNull();
    });

    it("denies when email_verified is absent", () => {
      expect(
        getStaticSignInReason({
          provider: "google",
          profile: {} as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBeNull();
    });

    it("admits a verified (boolean true) allowlisted email with the email reason", () => {
      expect(
        getStaticSignInReason({
          provider: "google",
          profile: { email_verified: true } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBe("email_allowlist");
    });

    it('admits a verified email when email_verified is the string "true"', () => {
      expect(
        getStaticSignInReason({
          provider: "google",
          profile: { email_verified: "true" } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBe("email_allowlist");
    });

    it('accepts a mixed-case "True" string (case-insensitive normalization)', () => {
      expect(
        getStaticSignInReason({
          provider: "google",
          profile: { email_verified: "True" } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBe("email_allowlist");
    });

    it("denies a verified email that is not on any allowlist", () => {
      expect(
        getStaticSignInReason({
          provider: "google",
          profile: { email_verified: true } as unknown as Profile,
          email: "stranger@gmail.com",
          config,
        })
      ).toBeNull();
    });
  });

  describe("GitHub", () => {
    it("admits an allowlisted GitHub username without an email_verified check", () => {
      expect(
        getStaticSignInReason({
          provider: "github",
          profile: { login: "octocat" } as unknown as Profile,
          email: "octo@company.com",
          config: cfg({ allowedUsers: ["octocat"] }),
        })
      ).toBe("username_allowlist");
    });

    it("denies a non-allowlisted GitHub user", () => {
      expect(
        getStaticSignInReason({
          provider: "github",
          profile: { login: "stranger" } as unknown as Profile,
          email: "stranger@other.com",
          config: cfg({ allowedDomains: ["company.com"], allowedUsers: ["octocat"] }),
        })
      ).toBeNull();
    });

    it("treats an undefined provider as the GitHub path", () => {
      expect(
        getStaticSignInReason({
          provider: undefined,
          profile: { login: "octocat" } as unknown as Profile,
          email: "octo@company.com",
          config: cfg({ allowedUsers: ["octocat"] }),
        })
      ).toBe("username_allowlist");
    });
  });
});

describe("applyJwtClaims", () => {
  it("captures SCM credentials and identity for a GitHub sign-in", () => {
    const token = applyJwtClaims(
      {},
      {
        provider: "github",
        type: "oauth",
        providerAccountId: "12345",
        access_token: "gho_abc",
        refresh_token: "ghr_def",
        expires_at: 1_700_000_000,
      } as Account,
      { id: 12345, login: "octocat" } as unknown as Profile
    );

    expect(token.provider).toBe("github");
    expect(token.providerUserId).toBe("12345");
    expect(token.githubUserId).toBe("12345");
    expect(token.githubLogin).toBe("octocat");
    expect(token.accessToken).toBe("gho_abc");
    expect(token.refreshToken).toBe("ghr_def");
    expect(token.accessTokenExpiresAt).toBe(1_700_000_000 * 1000);
  });

  it("does NOT capture an access token for a Google sign-in (F1 credential-leak gate)", () => {
    const token = applyJwtClaims(
      {},
      {
        provider: "google",
        type: "oauth",
        providerAccountId: "google-sub-1",
        access_token: "ya29.google-token",
        refresh_token: "1//google-refresh",
        expires_at: 1_700_000_000,
      } as Account,
      { sub: "google-sub-1", email: "pm@gmail.com", email_verified: true } as unknown as Profile
    );

    expect(token.accessToken).toBeUndefined();
    expect(token.refreshToken).toBeUndefined();
    expect(token.accessTokenExpiresAt).toBeUndefined();
    expect(token.provider).toBe("google");
    expect(token.providerUserId).toBe("google-sub-1");
    expect(token.githubUserId).toBeUndefined();
    expect(token.githubLogin).toBeUndefined();
  });

  it("clears stale GitHub claims when a prior GitHub JWT is reused for a Google sign-in", () => {
    const token = applyJwtClaims(
      {
        provider: "github",
        providerUserId: "12345",
        githubUserId: "12345",
        githubLogin: "octocat",
        accessToken: "gho_abc",
        refreshToken: "ghr_def",
        accessTokenExpiresAt: 1_700_000_000 * 1000,
      } as JWT,
      {
        provider: "google",
        type: "oauth",
        providerAccountId: "google-sub-1",
        access_token: "ya29.google-token",
        refresh_token: "1//google-refresh",
        expires_at: 1_700_000_000,
      } as Account,
      { sub: "google-sub-1", email: "pm@gmail.com", email_verified: true } as unknown as Profile
    );

    expect(token.provider).toBe("google");
    expect(token.providerUserId).toBe("google-sub-1");
    expect(token.accessToken).toBeUndefined();
    expect(token.refreshToken).toBeUndefined();
    expect(token.accessTokenExpiresAt).toBeUndefined();
    expect(token.githubUserId).toBeUndefined();
    expect(token.githubLogin).toBeUndefined();
  });

  it("backfills provider/providerUserId for a legacy GitHub JWT with no account on the request", () => {
    const token = applyJwtClaims({ githubUserId: "999" } as JWT, null, undefined);

    expect(token.provider).toBe("github");
    expect(token.providerUserId).toBe("999");
    // No account on the request, so no fresh credentials are captured.
    expect(token.accessToken).toBeUndefined();
  });

  it("leaves an anonymous token untouched", () => {
    const token = applyJwtClaims({}, null, undefined);

    expect(token.provider).toBeUndefined();
    expect(token.providerUserId).toBeUndefined();
  });
});

describe("applySessionUser", () => {
  function emptySession(): Session {
    return { user: {}, expires: "" };
  }

  it("maps a GitHub token onto the session user", () => {
    const session = applySessionUser(emptySession(), {
      provider: "github",
      providerUserId: "12345",
      githubUserId: "12345",
      githubLogin: "octocat",
    } as JWT);

    expect(session.user.id).toBe("12345");
    expect(session.user.provider).toBe("github");
    expect(session.user.login).toBe("octocat");
  });

  it("maps a Google token onto the session user with no login", () => {
    const session = applySessionUser(emptySession(), {
      provider: "google",
      providerUserId: "google-sub-1",
    } as JWT);

    expect(session.user.id).toBe("google-sub-1");
    expect(session.user.provider).toBe("google");
    expect(session.user.login).toBeUndefined();
  });

  it("falls back to githubUserId for a legacy token without providerUserId", () => {
    const session = applySessionUser(emptySession(), { githubUserId: "999" } as JWT);

    expect(session.user.id).toBe("999");
  });
});

async function importAuthModule(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  resetAuthEnv();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return import("./auth");
}

function resetAuthEnv(): void {
  for (const key of [
    "ALLOWED_EMAIL_DOMAINS",
    "ALLOWED_USERS",
    "ALLOWED_EMAILS",
    "ALLOWED_GITHUB_ORGS",
    "UNSAFE_ALLOW_ALL_USERS",
    "NEXT_PUBLIC_APP_NAME",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ]) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
}

function getGitHubProviderScope(authOptions: NextAuthOptions): string {
  const provider = authOptions.providers[0] as {
    options: { authorization: { params: { scope: string } } };
  };
  return provider.options.authorization.params.scope;
}

function getSignIn(authOptions: NextAuthOptions) {
  const signIn = authOptions.callbacks?.signIn;
  if (!signIn) {
    throw new Error("signIn callback is not configured");
  }

  return signIn;
}
