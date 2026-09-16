import { describe, expect, it, vi } from "vitest";
import type { UserStore } from "../db/user-store";
import {
  parseAuthorId,
  resolveCurrentGitHubAccessToken,
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

const GITHUB_ACCOUNT_INFO = {
  user: { id: "42" },
  data: {
    provider: "github",
    issuer: "https://github.com",
    subject: "42",
    login: "ada",
    displayName: "Ada Lovelace",
    verifiedEmails: ["private@example.com"],
    primaryEmail: "private@example.com",
  },
} as const;

describe("resolveGitHubEnrichment", () => {
  it("returns null when the canonical user has no linked GitHub identity", async () => {
    const store = fakeStore([{ provider: "google", providerUserId: "google-sub-1" }]);

    await expect(resolveGitHubEnrichment(store, "user-1")).resolves.toBeNull();
  });

  it("returns identity metadata without consulting a credential store", async () => {
    const store = fakeStore(
      [
        { provider: "google", providerUserId: "google-sub-1" },
        {
          provider: "github",
          providerUserId: "42",
          providerLogin: "ada",
          providerEmail: "private@example.com",
        },
      ],
      { id: "user-1", displayName: "Ada Lovelace" }
    );

    await expect(resolveGitHubEnrichment(store, "user-1")).resolves.toEqual({
      scmUserId: "42",
      scmLogin: "ada",
      displayName: "Ada Lovelace",
      email: "42+ada@users.noreply.github.com",
    });
  });

  it("rejects multiple linked GitHub accounts", async () => {
    const store = fakeStore([
      { provider: "github", providerUserId: "42" },
      { provider: "github", providerUserId: "43" },
    ]);

    await expect(resolveGitHubEnrichment(store, "user-1")).rejects.toThrow(
      "User resolves to multiple GitHub provider accounts"
    );
  });
});

describe("resolveGitHubEnrichmentForRequest", () => {
  it("uses only canonical identity for an admitted service actor", async () => {
    const store = fakeStore([{ provider: "github", providerUserId: "42", providerLogin: "ada" }], {
      id: "user-1",
      displayName: "Ada Lovelace",
    });

    await expect(
      resolveGitHubEnrichmentForRequest(store, "user-1", { kind: "service_principal" })
    ).resolves.toEqual({
      scmUserId: "42",
      scmLogin: "ada",
      displayName: "Ada Lovelace",
      email: "42+ada@users.noreply.github.com",
    });
  });

  it("accepts browser authority bound to the canonical GitHub identity", async () => {
    const store = fakeStore([{ provider: "github", providerUserId: "42", providerLogin: "ada" }]);
    const resolveProfile = vi.fn(async () => GITHUB_ACCOUNT_INFO);

    await expect(
      resolveGitHubEnrichmentForRequest(store, "user-1", {
        kind: "browser_session",
        githubAccount: { subject: "42", resolveProfile },
      })
    ).resolves.toMatchObject({ scmUserId: "42", scmLogin: "ada" });
    expect(resolveProfile).not.toHaveBeenCalled();
  });

  it("uses the verified browser profile when canonical GitHub metadata is incomplete", async () => {
    await expect(
      resolveGitHubEnrichmentForRequest(
        fakeStore([{ provider: "github", providerUserId: "42" }]),
        "user-1",
        {
          kind: "browser_session",
          githubAccount: {
            subject: "42",
            resolveProfile: vi.fn(async () => GITHUB_ACCOUNT_INFO),
          },
        }
      )
    ).resolves.toEqual({
      scmUserId: "42",
      scmLogin: "ada",
      displayName: "Ada Lovelace",
      email: "42+ada@users.noreply.github.com",
    });
  });

  it("keeps canonical metadata when the linked GitHub identity has no OAuth grant", async () => {
    await expect(
      resolveGitHubEnrichmentForRequest(
        fakeStore([{ provider: "github", providerUserId: "42" }]),
        "user-1",
        {
          kind: "browser_session",
          githubAccount: {
            subject: "42",
            resolveProfile: vi.fn(async () => null),
          },
        }
      )
    ).resolves.toEqual({
      scmUserId: "42",
      scmLogin: undefined,
      displayName: undefined,
      email: undefined,
    });
  });

  it("rejects browser authority that differs from the canonical identity", async () => {
    const store = fakeStore([{ provider: "github", providerUserId: "42" }]);

    await expect(
      resolveGitHubEnrichmentForRequest(store, "user-1", {
        kind: "browser_session",
        githubAccount: {
          subject: "7",
          resolveProfile: vi.fn(async () => GITHUB_ACCOUNT_INFO),
        },
      })
    ).rejects.toThrow("GitHub account authority is corrupt");
  });

  it("rejects a browser session missing its canonical linked account", async () => {
    const store = fakeStore([{ provider: "github", providerUserId: "42" }]);

    await expect(
      resolveGitHubEnrichmentForRequest(store, "user-1", {
        kind: "browser_session",
        githubAccount: null,
      })
    ).rejects.toThrow("GitHub account authority is corrupt");
  });
});

describe("resolveCurrentGitHubAccessToken", () => {
  const accountClient = {
    listUserAccounts: vi.fn(async () => []),
    getAccessToken: vi.fn(async () => ({ accessToken: "current-access-token" })),
    refreshToken: vi.fn(async () => ({ accessToken: "refreshed-access-token" })),
    accountInfo: vi.fn(async () => GITHUB_ACCOUNT_INFO),
  };

  it("does not construct Better Auth when the GitHub identity was unlinked", async () => {
    const getAccountClient = vi.fn(() => accountClient);

    await expect(
      resolveCurrentGitHubAccessToken(fakeStore([]), getAccountClient, "user-1", "42")
    ).resolves.toBeNull();
    expect(getAccountClient).not.toHaveBeenCalled();
  });

  it("classifies Better Auth token retrieval failures", async () => {
    const retrievalError = new Error("Access token not found");
    const unavailableClient = {
      ...accountClient,
      getAccessToken: vi.fn(async () => {
        throw retrievalError;
      }),
    };

    await expect(
      resolveCurrentGitHubAccessToken(
        fakeStore([{ provider: "github", providerUserId: "42" }]),
        () => unavailableClient,
        "user-1",
        "42"
      )
    ).rejects.toMatchObject({
      name: "BetterAuthGitHubTokenUnavailableError",
      retrievalError,
    });
  });

  it("refreshes a token that expires inside the PR safety window", async () => {
    const accountInfo = vi.fn(async () => GITHUB_ACCOUNT_INFO);
    const refreshToken = vi.fn(async () => ({
      accessToken: "refreshed-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    }));
    const expiringClient = {
      ...accountClient,
      accountInfo,
      refreshToken,
      getAccessToken: vi.fn(async () => ({
        accessToken: "expiring-token",
        accessTokenExpiresAt: new Date(Date.now() + 30_000),
      })),
    };

    await expect(
      resolveCurrentGitHubAccessToken(
        fakeStore([{ provider: "github", providerUserId: "42" }]),
        () => expiringClient,
        "user-1",
        "42"
      )
    ).resolves.toBe("refreshed-access-token");
    expect(refreshToken).toHaveBeenCalledWith({
      body: { providerId: "github", accountId: "42", userId: "user-1" },
    });
    expect(accountInfo).toHaveBeenCalledOnce();
  });

  it("returns null for a linked identity without an OAuth grant", async () => {
    const accountInfo = vi.fn(async () => GITHUB_ACCOUNT_INFO);
    const grantlessClient = {
      ...accountClient,
      accountInfo,
      getAccessToken: vi.fn(async () => ({ accessToken: "" })),
    };

    await expect(
      resolveCurrentGitHubAccessToken(
        fakeStore([{ provider: "github", providerUserId: "42" }]),
        () => grantlessClient,
        "user-1",
        "42"
      )
    ).resolves.toBeNull();
    expect(accountInfo).not.toHaveBeenCalled();
  });

  it("resolves the current credential after validating canonical identity", async () => {
    await expect(
      resolveCurrentGitHubAccessToken(
        fakeStore([{ provider: "github", providerUserId: "42" }]),
        () => accountClient,
        "user-1",
        "42"
      )
    ).resolves.toBe("current-access-token");
    expect(accountClient.getAccessToken).toHaveBeenCalledWith({
      body: { providerId: "github", accountId: "42", userId: "user-1" },
    });
  });

  it("rejects provider profile substitution", async () => {
    const substitutedClient = {
      ...accountClient,
      accountInfo: vi.fn(async () => ({
        user: { id: "7" },
        data: { ...GITHUB_ACCOUNT_INFO.data, subject: "7", login: "mallory" },
      })),
    };

    await expect(
      resolveCurrentGitHubAccessToken(
        fakeStore([{ provider: "github", providerUserId: "42" }]),
        () => substitutedClient,
        "user-1",
        "42"
      )
    ).rejects.toThrow("Better Auth returned a mismatched GitHub account");
  });

  it("treats a malformed token response as an integrity failure", async () => {
    const malformedClient = {
      ...accountClient,
      getAccessToken: vi.fn(async () => ({})),
    };

    await expect(
      resolveCurrentGitHubAccessToken(
        fakeStore([{ provider: "github", providerUserId: "42" }]),
        () => malformedClient,
        "user-1",
        "42"
      )
    ).rejects.toThrow();
  });
});
