import { describe, expect, it, vi } from "vitest";
import { generateEncryptionKey } from "../auth/crypto";
import type { UserStore } from "../db/user-store";
import type { Env } from "../types";
import {
  parseAuthorId,
  resolveBetterAuthGitHubEnrichment,
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
  it("rejects invalid token-encryption key material before resolving identity", async () => {
    const env = { TOKEN_ENCRYPTION_KEY: "dG9vc2hvcnQ=" } as unknown as Env;
    const store = { getIdentitiesForUser: vi.fn(), getUserById: vi.fn() } as unknown as UserStore;
    const authority = {
      kind: "service_principal",
      accountClient: {},
    } as unknown as Parameters<typeof resolveGitHubEnrichmentForRequest>[3];

    await expect(
      resolveGitHubEnrichmentForRequest(env, store, "user-1", authority)
    ).rejects.toThrow(/TOKEN_ENCRYPTION_KEY must decode to 32 bytes/);
    expect(store.getIdentitiesForUser).not.toHaveBeenCalled();
  });

  it("uses the admitted service actor's Better Auth account", async () => {
    const getAccessToken = vi.fn(async () => ({
      accessToken: "current-access-token",
      accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    }));
    const store = fakeStore([{ provider: "github", providerUserId: "42" }]);
    const env = { TOKEN_ENCRYPTION_KEY: generateEncryptionKey() } as Env;

    const enrichment = await resolveGitHubEnrichmentForRequest(env, store, "user-1", {
      kind: "service_principal",
      accountClient: {
        listUserAccounts: vi.fn(async () => []),
        getAccessToken,
        accountInfo: vi.fn(async () => GITHUB_ACCOUNT_INFO),
      },
    });

    expect(enrichment).toMatchObject({
      scmUserId: "42",
      scmLogin: "ada",
      accessTokenEncrypted: expect.any(String),
    });
    expect(getAccessToken).toHaveBeenCalledWith({
      body: { providerId: "github", accountId: "42", userId: "user-1" },
    });
  });

  it("retains service actor identity when Better Auth has no usable token", async () => {
    const store = fakeStore([{ provider: "github", providerUserId: "42", providerLogin: "ada" }], {
      id: "user-1",
      displayName: "Ada Lovelace",
    });

    await expect(
      resolveGitHubEnrichmentForRequest(
        { TOKEN_ENCRYPTION_KEY: generateEncryptionKey() } as Env,
        store,
        "user-1",
        {
          kind: "service_principal",
          accountClient: {
            listUserAccounts: vi.fn(async () => []),
            getAccessToken: vi.fn(async () => {
              throw new Error("Access token not found");
            }),
            accountInfo: vi.fn(async () => null),
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

  it("rejects a mismatched service actor profile instead of falling back", async () => {
    const store = fakeStore([{ provider: "github", providerUserId: "42" }]);

    await expect(
      resolveGitHubEnrichmentForRequest(
        { TOKEN_ENCRYPTION_KEY: generateEncryptionKey() } as Env,
        store,
        "user-1",
        {
          kind: "service_principal",
          accountClient: {
            listUserAccounts: vi.fn(async () => []),
            getAccessToken: vi.fn(async () => ({ accessToken: "token" })),
            accountInfo: vi.fn(async () => ({
              user: { id: "7" },
              data: { ...GITHUB_ACCOUNT_INFO.data, subject: "7" },
            })),
          },
        }
      )
    ).rejects.toThrow("Better Auth returned a mismatched GitHub account");
  });
});

describe("resolveBetterAuthGitHubEnrichment", () => {
  const githubAccount = { subject: "42" };

  it("gets a current token and binds it to the verified GitHub profile", async () => {
    const getAccessToken = vi.fn(async () => ({
      accessToken: "current-access-token",
      accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    }));
    const getAccountInfo = vi.fn(async () => GITHUB_ACCOUNT_INFO);
    const encryptAccessToken = vi.fn(async () => "encrypted-current-access-token");

    await expect(
      resolveBetterAuthGitHubEnrichment("user-1", githubAccount, {
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

    const selection = { providerId: "github", accountId: "42", userId: "user-1" };
    expect(getAccessToken).toHaveBeenCalledWith(selection);
    expect(getAccountInfo).toHaveBeenCalledWith(selection);
  });

  it("rejects provider profile substitution", async () => {
    await expect(
      resolveBetterAuthGitHubEnrichment("user-1", githubAccount, {
        getAccessToken: async () => ({ accessToken: "token" }),
        getAccountInfo: async () => ({
          user: { id: "7" },
          data: {
            ...GITHUB_ACCOUNT_INFO.data,
            subject: "7",
            login: "mallory",
          },
        }),
        encryptAccessToken: async () => "encrypted",
      })
    ).rejects.toThrow("Better Auth returned a mismatched GitHub account");
  });
});
