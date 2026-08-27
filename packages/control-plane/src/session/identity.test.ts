import { describe, expect, it, vi } from "vitest";
import { generateEncryptionKey } from "../auth/crypto";
import type { UserStore } from "../db/user-store";
import type { Env } from "../types";
import {
  parseAuthorId,
  resolveBrowserGitHubEnrichment,
  resolveGitAuthorIdentity,
  resolveGitHubEnrichment,
  resolveGitHubEnrichmentForRequest,
} from "./identity";

describe("resolveGitAuthorIdentity", () => {
  it("derives a canonical noreply author from a trusted GitHub id and login", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "github",
        scmUserId: "1001",
        scmLogin: "ada",
        scmName: "Ada Lovelace",
        scmEmail: "ada@private.example",
      })
    ).toEqual({
      name: "Ada Lovelace",
      email: "1001+ada@users.noreply.github.com",
    });
  });

  it("rejects a non-numeric GitHub user id", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "github",
        scmUserId: "caller-supplied",
        scmLogin: "ada",
        scmName: "Ada Lovelace",
        scmEmail: "ada@example.com",
      })
    ).toBeNull();
  });

  it("rejects a value that is not a GitHub login", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "github",
        scmUserId: "1001",
        scmLogin: "ada@example.com",
        scmName: "Ada Lovelace",
      })
    ).toBeNull();
  });

  it("preserves existing GitLab author metadata", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "gitlab",
        scmUserId: "gitlab-user-1",
        scmLogin: "group-user",
        scmName: "Grace Hopper",
        scmEmail: "grace@gitlab.example",
      })
    ).toEqual({
      name: "Grace Hopper",
      email: "grace@gitlab.example",
    });
  });

  it("preserves GitLab's field-by-field fallback behavior", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "gitlab",
        scmUserId: "gitlab-user-1",
        scmLogin: "group-user",
        scmName: "Grace Hopper",
        scmEmail: null,
      })
    ).toEqual({
      name: "Grace Hopper",
      email: "open-inspect@noreply.github.com",
    });
  });
});

describe("parseAuthorId", () => {
  it("parses github authorId", () => {
    expect(parseAuthorId("github:1001")).toEqual({
      provider: "github",
      providerUserId: "1001",
    });
  });

  it("parses slack authorId", () => {
    expect(parseAuthorId("slack:U123ABC")).toEqual({
      provider: "slack",
      providerUserId: "U123ABC",
    });
  });

  it("parses linear authorId", () => {
    expect(parseAuthorId("linear:abc-def")).toEqual({
      provider: "linear",
      providerUserId: "abc-def",
    });
  });

  it("returns null for plain user ID (web client)", () => {
    expect(parseAuthorId("user-id-123")).toBeNull();
  });

  it("returns null for 'anonymous'", () => {
    expect(parseAuthorId("anonymous")).toBeNull();
  });

  it("returns null for unknown provider prefix", () => {
    expect(parseAuthorId("unknown:12345")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAuthorId("")).toBeNull();
  });
});

describe("resolveGitHubEnrichment", () => {
  // This is the fire-time F1/F2 gate: a resolved user with no linked GitHub
  // identity must yield null so no SCM token is attached (bot-attributed
  // fallback). The db stub answers the token-store lookup with "no stored
  // tokens", so these tests pin the identity-selection boundary without D1.
  const emptyTokenDb = {
    prepare: () => ({ bind: () => ({ first: async () => null }) }),
  } as unknown as Env["DB"];
  const env = {
    DB: emptyTokenDb,
    TOKEN_ENCRYPTION_KEY: generateEncryptionKey(),
  } as unknown as Env;

  function fakeStore(
    identities: Array<{
      provider: string;
      providerUserId: string;
      providerEmail?: string | null;
      providerLogin?: string | null;
    }>,
    user?: { id: string; displayName?: string | null; email?: string | null }
  ): UserStore {
    return {
      getIdentitiesForUser: async () => identities,
      getUserById: async () => user ?? null,
    } as unknown as UserStore;
  }

  it("returns null for a pure-Google user — no linked GitHub identity means no SCM token", async () => {
    const store = fakeStore([
      { provider: "google", providerUserId: "google-sub-1", providerEmail: "pm@gmail.com" },
    ]);

    await expect(resolveGitHubEnrichment(env, env.DB, store, "user-1")).resolves.toBeNull();
  });

  it("enriches from the linked GitHub identity, never the Google one", async () => {
    const store = fakeStore(
      [
        { provider: "google", providerUserId: "google-sub-1", providerEmail: "pm@gmail.com" },
        {
          provider: "github",
          providerUserId: "gh-42",
          providerLogin: "pm-dev",
          providerEmail: "pm@users.noreply.github.com",
        },
      ],
      { id: "user-1", displayName: "PM Person", email: "pm@gmail.com" }
    );

    const enrichment = await resolveGitHubEnrichment(env, env.DB, store, "user-1");

    expect(enrichment).not.toBeNull();
    // The SCM identifier is the GitHub provider id — never the Google sub.
    expect(enrichment!.scmUserId).toBe("gh-42");
    expect(enrichment!.scmLogin).toBe("pm-dev");
    // No stored tokens for this identity → no token material leaks in.
    expect(enrichment!.accessTokenEncrypted).toBeUndefined();
  });

  it("uses the canonical GitHub noreply address instead of a stored private email", async () => {
    const store = fakeStore(
      [
        {
          provider: "github",
          providerUserId: "42",
          providerLogin: "pm-dev",
          providerEmail: "private@example.com",
        },
      ],
      { id: "user-1", displayName: "PM Person" }
    );

    const enrichment = await resolveGitHubEnrichment(env, env.DB, store, "user-1");

    expect(enrichment?.email).toBe("42+pm-dev@users.noreply.github.com");
  });
});

describe("resolveGitHubEnrichmentForRequest", () => {
  it("rejects invalid token-encryption key material before any authority branch runs", async () => {
    const env = { DB: {}, TOKEN_ENCRYPTION_KEY: "dG9vc2hvcnQ=" } as unknown as Env;
    const store = { getIdentitiesForUser: vi.fn(), getUserById: vi.fn() } as unknown as UserStore;
    const authority = {
      kind: "browser_session",
      accountClient: {},
      githubAccount: null,
    } as unknown as Parameters<typeof resolveGitHubEnrichmentForRequest>[4];

    await expect(
      resolveGitHubEnrichmentForRequest(env, env.DB, store, "user-1", authority)
    ).rejects.toThrow(/TOKEN_ENCRYPTION_KEY must decode to 32 bytes/);
    // The guard fires before either branch touches identity or account state.
    expect(store.getIdentitiesForUser).not.toHaveBeenCalled();
  });
});

describe("resolveBrowserGitHubEnrichment", () => {
  const githubAccount = {
    subject: "42",
  };

  it("gets a current Better Auth token and binds it to the verified GitHub profile", async () => {
    const getAccessToken = vi.fn(async () => ({
      accessToken: "current-access-token",
      accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      scopes: [],
    }));
    const getAccountInfo = vi.fn(async () => ({
      user: {
        id: "42",
        name: "Ada Lovelace",
        email: "private@example.com",
        emailVerified: true,
      },
      data: {
        provider: "github",
        issuer: "https://github.com",
        subject: "42",
        login: "ada",
        displayName: "Ada Lovelace",
        verifiedEmails: ["private@example.com"],
        primaryEmail: "private@example.com",
      },
    }));
    const encryptAccessToken = vi.fn(async () => "encrypted-current-access-token");

    await expect(
      resolveBrowserGitHubEnrichment("0123456789abcdef0123456789abcdef", githubAccount, {
        getAccessToken,
        getAccountInfo,
        encryptAccessToken,
      })
    ).resolves.toEqual({
      scmUserId: "42",
      scmLogin: "ada",
      displayName: "Ada Lovelace",
      email: "42+ada@users.noreply.github.com",
      accessTokenEncrypted: "encrypted-current-access-token",
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z").getTime(),
    });

    const accountSelection = {
      providerId: "github",
      accountId: "42",
      userId: "0123456789abcdef0123456789abcdef",
    };
    expect(getAccessToken).toHaveBeenCalledWith(accountSelection);
    expect(getAccountInfo).toHaveBeenCalledWith(accountSelection);
    expect(encryptAccessToken).toHaveBeenCalledWith("current-access-token");
  });

  it("rejects provider profile substitution", async () => {
    await expect(
      resolveBrowserGitHubEnrichment("0123456789abcdef0123456789abcdef", githubAccount, {
        getAccessToken: async () => ({ accessToken: "token" }),
        getAccountInfo: async () => ({
          user: {
            id: "7",
            name: "Mallory",
            email: "mallory@example.com",
            emailVerified: true,
          },
          data: {
            provider: "github",
            issuer: "https://github.com",
            subject: "7",
            login: "mallory",
            verifiedEmails: ["mallory@example.com"],
            primaryEmail: "mallory@example.com",
          },
        }),
        encryptAccessToken: async () => "encrypted",
      })
    ).rejects.toThrow("Better Auth returned a mismatched GitHub account");
  });
});
