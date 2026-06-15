import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Profile, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { AccessControlConfig } from "./access-control";
import {
  applyJwtClaims,
  applySessionUser,
  buildSignInDecision,
  getVerifiedPrimaryGitHubEmail,
} from "./auth";

function cfg(overrides: Partial<AccessControlConfig> = {}): AccessControlConfig {
  return {
    allowedDomains: [],
    allowedUsers: [],
    allowedEmails: [],
    unsafeAllowAllUsers: false,
    ...overrides,
  };
}

describe("getVerifiedPrimaryGitHubEmail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

describe("buildSignInDecision", () => {
  describe("Google", () => {
    const config = cfg({ allowedEmails: ["pm@gmail.com"] });

    it("denies an unverified email (boolean false) before any allowlist match", () => {
      expect(
        buildSignInDecision({
          provider: "google",
          profile: { email_verified: false } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBe(false);
    });

    it('denies an unverified email when email_verified is the string "false"', () => {
      expect(
        buildSignInDecision({
          provider: "google",
          profile: { email_verified: "false" } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBe(false);
    });

    it("denies when email_verified is absent", () => {
      expect(
        buildSignInDecision({
          provider: "google",
          profile: {} as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBe(false);
    });

    it("allows a verified (boolean true) allowlisted email", () => {
      expect(
        buildSignInDecision({
          provider: "google",
          profile: { email_verified: true } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBe(true);
    });

    it('allows a verified email when email_verified is the string "true"', () => {
      expect(
        buildSignInDecision({
          provider: "google",
          profile: { email_verified: "true" } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBe(true);
    });

    it('accepts a mixed-case "True" string (case-insensitive normalization)', () => {
      expect(
        buildSignInDecision({
          provider: "google",
          profile: { email_verified: "True" } as unknown as Profile,
          email: "pm@gmail.com",
          config,
        })
      ).toBe(true);
    });

    it("denies a verified email that is not on any allowlist", () => {
      expect(
        buildSignInDecision({
          provider: "google",
          profile: { email_verified: true } as unknown as Profile,
          email: "stranger@gmail.com",
          config,
        })
      ).toBe(false);
    });
  });

  describe("GitHub", () => {
    it("admits an allowlisted GitHub username without an email_verified check", () => {
      expect(
        buildSignInDecision({
          provider: "github",
          profile: { login: "octocat" } as unknown as Profile,
          email: "octo@company.com",
          config: cfg({ allowedUsers: ["octocat"] }),
        })
      ).toBe(true);
    });

    it("denies a non-allowlisted GitHub user", () => {
      expect(
        buildSignInDecision({
          provider: "github",
          profile: { login: "stranger" } as unknown as Profile,
          email: "stranger@other.com",
          config: cfg({ allowedDomains: ["company.com"], allowedUsers: ["octocat"] }),
        })
      ).toBe(false);
    });

    it("treats an undefined provider as the GitHub path", () => {
      expect(
        buildSignInDecision({
          provider: undefined,
          profile: { login: "octocat" } as unknown as Profile,
          email: "octo@company.com",
          config: cfg({ allowedUsers: ["octocat"] }),
        })
      ).toBe(true);
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
