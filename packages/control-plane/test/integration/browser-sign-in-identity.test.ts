import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  AccountLinkRequiredError,
  BrowserSignInIdentityResolver,
  InvalidProviderIdentityEvidenceError,
  ProviderIdentityAdapterMismatchError,
  type BrowserSignInIdentityResolverDependencies,
} from "../../src/auth/browser-sign-in-identity";
import {
  BrowserSignInIdentityStore,
  type ProviderCredentialWriteStorePort,
} from "../../src/db/browser-sign-in-identities";
import { ProviderCredentialStore } from "../../src/db/provider-credentials";
import { cleanD1Tables } from "./cleanup";

const NOW_MS = 1_800_000_000_000;
const GITHUB_CREDENTIAL = {
  kind: "access_only_nonexpiring" as const,
  accessToken: "ghu_test_access",
};

function createProviderCredentialStore(now = NOW_MS): ProviderCredentialStore {
  return new ProviderCredentialStore(
    env.DB,
    {
      encrypt: async (plaintext, context) => btoa(JSON.stringify({ plaintext, context })),
      decrypt: async (encrypted) =>
        (JSON.parse(atob(encrypted)) as { plaintext: string }).plaintext,
    },
    { now: () => now }
  );
}

function createIdentityResolver(
  dependencies: Omit<BrowserSignInIdentityResolverDependencies, "store"> & {
    providerCredentialStore?: ProviderCredentialWriteStorePort;
  }
): BrowserSignInIdentityResolver {
  const { providerCredentialStore = createProviderCredentialStore(), ...serviceDependencies } =
    dependencies;
  return new BrowserSignInIdentityResolver({
    ...serviceDependencies,
    store: new BrowserSignInIdentityStore(env.DB, providerCredentialStore),
  });
}

describe("BrowserSignInIdentityResolver", () => {
  beforeEach(cleanD1Tables);

  it("creates an issuer-qualified canonical identity without requiring email evidence", async () => {
    const ids = ["user-1", "identity-1"];
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: {
        generate: () => ids.shift() ?? "unexpected-id",
      },
    });

    await expect(
      service.resolve({
        identity: {
          provider: "github",
          issuer: "https://github.com",
          subject: "github-user-1",
          login: "octocat",
          displayName: "Octo Cat",
          avatarUrl: "https://avatars.example/octocat",
          verifiedEmails: [],
          primaryEmail: null,
        },
        credential: GITHUB_CREDENTIAL,
      })
    ).resolves.toEqual({
      userId: "user-1",
      providerIdentityId: "identity-1",
      isNewUser: true,
      collisionCount: 0,
    });

    await expect(
      env.DB.prepare(
        `SELECT
           users.id, users.email, user_identities.provider,
           user_identities.provider_issuer, user_identities.provider_user_id
         FROM users
         JOIN user_identities ON user_identities.user_id = users.id`
      ).first()
    ).resolves.toEqual({
      id: "user-1",
      email: null,
      provider: "github",
      provider_issuer: "https://github.com",
      provider_user_id: "github-user-1",
    });
  });

  it("fails closed without creating a user when a new subject collides", async () => {
    const ids = ["existing-user", "existing-identity", "rejected-user", "rejected-identity"];
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
    });
    await service.resolve({
      identity: {
        provider: "github",
        issuer: "https://github.com",
        subject: "github-user-1",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: GITHUB_CREDENTIAL,
    });

    let rejection: unknown;
    try {
      await service.resolve({
        identity: {
          provider: "google",
          issuer: "https://accounts.google.com",
          subject: "google-user-1",
          verifiedEmails: ["person@example.com"],
          primaryEmail: "person@example.com",
        },
        credential: null,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(AccountLinkRequiredError);
    expect(rejection).toMatchObject({ collisionCount: 1 });
    expect(rejection).not.toHaveProperty("conflictingEmails");

    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM users) AS users,
           (SELECT count(*) FROM user_identities) AS identities,
           (SELECT count(*) FROM verified_email_claims) AS claims`
      ).first()
    ).resolves.toEqual({ users: 1, identities: 1, claims: 1 });
  });

  it("preserves an established subject while maintaining its unclaimed email evidence", async () => {
    const ids = ["github-user", "github-identity", "google-user", "google-identity"];
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
    });
    await service.resolve({
      identity: {
        provider: "github",
        issuer: "https://github.com",
        subject: "github-subject",
        verifiedEmails: ["github@example.com"],
        primaryEmail: "github@example.com",
      },
      credential: GITHUB_CREDENTIAL,
    });
    await service.resolve({
      identity: {
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["google@example.com"],
        primaryEmail: "google@example.com",
      },
      credential: null,
    });

    await expect(
      service.resolve({
        identity: {
          provider: "google",
          issuer: "https://accounts.google.com",
          subject: "google-subject",
          displayName: "Updated Google User",
          verifiedEmails: ["google@example.com", "new@example.com", "github@example.com"],
          primaryEmail: "google@example.com",
        },
        credential: null,
      })
    ).resolves.toEqual({
      userId: "google-user",
      providerIdentityId: "google-identity",
      isNewUser: false,
      collisionCount: 1,
    });

    await expect(
      env.DB.prepare(
        `SELECT email, user_id, source_provider_identity_id
         FROM verified_email_claims
         WHERE email = 'new@example.com'`
      ).first()
    ).resolves.toEqual({
      email: "new@example.com",
      user_id: "google-user",
      source_provider_identity_id: "google-identity",
    });
    await expect(
      env.DB.prepare(
        `SELECT user_id
         FROM user_identities
         WHERE id = 'google-identity'`
      ).first()
    ).resolves.toEqual({ user_id: "google-user" });
  });

  it("keeps canonical users.email stable while refreshing provider email metadata", async () => {
    const ids = ["user-1", "identity-1"];
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
    });
    await service.resolve({
      identity: {
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["original@example.com"],
        primaryEmail: "original@example.com",
      },
      credential: null,
    });

    await service.resolve({
      identity: {
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["current@example.com"],
        primaryEmail: "current@example.com",
      },
      credential: null,
    });

    await expect(
      env.DB.prepare(
        `SELECT users.email, user_identities.provider_email
         FROM users
         JOIN user_identities ON user_identities.user_id = users.id
         WHERE users.id = 'user-1'`
      ).first()
    ).resolves.toEqual({
      email: "original@example.com",
      provider_email: "current@example.com",
    });
  });

  it("uses claim uniqueness as the concurrency authority", async () => {
    const github = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: {
        generate: (() => {
          const ids = ["github-user", "github-identity"];
          return () => ids.shift() ?? "unexpected-github-id";
        })(),
      },
    });
    const google = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: {
        generate: (() => {
          const ids = ["google-user", "google-identity"];
          return () => ids.shift() ?? "unexpected-google-id";
        })(),
      },
    });

    const results = await Promise.allSettled([
      github.resolve({
        identity: {
          provider: "github",
          issuer: "https://github.com",
          subject: "github-subject",
          verifiedEmails: ["same@example.com"],
          primaryEmail: "same@example.com",
        },
        credential: GITHUB_CREDENTIAL,
      }),
      google.resolve({
        identity: {
          provider: "google",
          issuer: "https://accounts.google.com",
          subject: "google-subject",
          verifiedEmails: ["same@example.com"],
          primaryEmail: "same@example.com",
        },
        credential: null,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toEqual(
      expect.objectContaining({
        reason: expect.objectContaining({ name: "AccountLinkRequiredError" }),
      })
    );
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM users) AS users,
           (SELECT count(*) FROM user_identities) AS identities,
           (SELECT count(*) FROM verified_email_claims) AS claims`
      ).first()
    ).resolves.toEqual({ users: 1, identities: 1, claims: 1 });
  });

  it("commits a new identity and encrypted provider credential in one transaction", async () => {
    const credentialStore = new ProviderCredentialStore(
      env.DB,
      {
        encrypt: async (plaintext, context) => btoa(JSON.stringify({ plaintext, context })),
        decrypt: async (encrypted) =>
          (JSON.parse(atob(encrypted)) as { plaintext: string }).plaintext,
      },
      { now: () => NOW_MS }
    );
    const ids = ["user-1", "identity-1"];
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
      providerCredentialStore: credentialStore,
    });

    await service.resolve({
      identity: {
        provider: "github",
        issuer: "https://github.com",
        subject: "github-subject",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: {
        kind: "refreshable",
        accessToken: "ghu_access",
        accessExpiresAt: NOW_MS + 10_000,
        refreshToken: "ghr_refresh",
        refreshExpiresAt: null,
      },
    });

    await expect(credentialStore.get("identity-1")).resolves.toMatchObject({
      providerIdentityId: "identity-1",
      kind: "refreshable",
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
      rowVersion: 1,
    });
  });

  it("retries an atomic identity refresh when the prepared credential version becomes stale", async () => {
    const credentialStore = createProviderCredentialStore();
    const ids = ["user-1", "identity-1"];
    const initial = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
      providerCredentialStore: credentialStore,
    });
    await initial.resolve({
      identity: {
        provider: "github",
        issuer: "https://github.com",
        subject: "github-subject",
        displayName: "Original Name",
        verifiedEmails: ["original@example.com"],
        primaryEmail: "original@example.com",
      },
      credential: GITHUB_CREDENTIAL,
    });

    const staleMutation = await credentialStore.prepareSignInUpsert("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "stale-access-token",
    });
    await credentialStore.upsertFromSignIn("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "concurrent-access-token",
    });
    const prepareSignInUpsert = vi
      .fn<ProviderCredentialWriteStorePort["prepareSignInUpsert"]>()
      .mockResolvedValueOnce(staleMutation)
      .mockImplementation((providerIdentityId, credential, updatedAt) =>
        credentialStore.prepareSignInUpsert(providerIdentityId, credential, updatedAt)
      );
    const retryingStore: ProviderCredentialWriteStorePort = {
      prepareInitialInsert: (...args) => credentialStore.prepareInitialInsert(...args),
      prepareSignInUpsert,
      isSignInVersionConflict: (error) => credentialStore.isSignInVersionConflict(error),
    };
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS + 1_000 },
      idGenerator: { generate: () => "must-not-generate" },
      providerCredentialStore: retryingStore,
    });

    await expect(
      service.resolve({
        identity: {
          provider: "github",
          issuer: "https://github.com",
          subject: "github-subject",
          displayName: "Updated Name",
          verifiedEmails: ["original@example.com", "new@example.com"],
          primaryEmail: "new@example.com",
        },
        credential: {
          kind: "access_only_nonexpiring",
          accessToken: "final-access-token",
        },
      })
    ).resolves.toMatchObject({
      userId: "user-1",
      providerIdentityId: "identity-1",
      isNewUser: false,
    });

    expect(prepareSignInUpsert).toHaveBeenCalledTimes(2);
    await expect(
      env.DB.prepare("SELECT display_name FROM users WHERE id = 'user-1'").first()
    ).resolves.toEqual({ display_name: "Updated Name" });
    await expect(
      env.DB.prepare(
        "SELECT user_id FROM verified_email_claims WHERE email = 'new@example.com'"
      ).first()
    ).resolves.toEqual({ user_id: "user-1" });
    await expect(credentialStore.get("identity-1")).resolves.toMatchObject({
      accessToken: "final-access-token",
      rowVersion: 3,
    });
  });

  it("does not start identity creation when credential preparation fails", async () => {
    const credentialStore = new ProviderCredentialStore(
      env.DB,
      {
        encrypt: async () => {
          throw new Error("cipher unavailable");
        },
        decrypt: async () => {
          throw new Error("not reached");
        },
      },
      { now: () => NOW_MS }
    );
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => crypto.randomUUID() },
      providerCredentialStore: credentialStore,
    });

    await expect(
      service.resolve({
        identity: {
          provider: "github",
          issuer: "https://github.com",
          subject: "github-subject",
          verifiedEmails: ["person@example.com"],
          primaryEmail: "person@example.com",
        },
        credential: {
          kind: "access_only_nonexpiring",
          accessToken: "ghu_access",
        },
      })
    ).rejects.toThrow("cipher unavailable");
    await expect(env.DB.prepare("SELECT count(*) AS count FROM users").first()).resolves.toEqual({
      count: 0,
    });
  });

  it("rolls back user, identity, and claims when credential execution fails in the batch", async () => {
    const failingCredentialStore: ProviderCredentialWriteStorePort = {
      prepareInitialInsert: async () =>
        env.DB.prepare(
          `INSERT INTO provider_credentials (
               provider_identity_id, credential_kind,
               access_token_ciphertext, access_expires_at,
               refresh_token_ciphertext, refresh_expires_at,
               encryption_key_version, row_version, updated_at
             ) VALUES (?, 'invalid-kind', 'ciphertext', NULL, NULL, NULL, 1, 1, ?)`
        ).bind("identity-1", NOW_MS),
      prepareSignInUpsert: async () => {
        throw new Error("not reached");
      },
      isSignInVersionConflict: () => false,
    };
    const ids = ["user-1", "identity-1"];
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
      providerCredentialStore: failingCredentialStore,
    });

    await expect(
      service.resolve({
        identity: {
          provider: "github",
          issuer: "https://github.com",
          subject: "github-subject",
          verifiedEmails: ["person@example.com"],
          primaryEmail: "person@example.com",
        },
        credential: GITHUB_CREDENTIAL,
      })
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM users) AS users,
           (SELECT count(*) FROM user_identities) AS identities,
           (SELECT count(*) FROM verified_email_claims) AS claims,
           (SELECT count(*) FROM provider_credentials) AS credentials`
      ).first()
    ).resolves.toEqual({ users: 0, identities: 0, claims: 0, credentials: 0 });
  });

  it("rejects an issuer that was not selected by the configured provider adapter", async () => {
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => crypto.randomUUID() },
    });

    await expect(
      service.resolve({
        identity: {
          provider: "google",
          issuer: "https://attacker.example",
          subject: "subject",
          verifiedEmails: [],
          primaryEmail: null,
        },
        credential: null,
      })
    ).rejects.toBeInstanceOf(InvalidProviderIdentityEvidenceError);
  });

  it("preserves the provider subject exactly", async () => {
    const ids = ["user-1", "identity-1"];
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
    });

    await service.resolve({
      identity: {
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: " subject-with-significant-spaces ",
        verifiedEmails: [],
        primaryEmail: null,
      },
      credential: null,
    });

    await expect(
      env.DB.prepare(
        `SELECT provider_user_id
         FROM user_identities
         WHERE id = 'identity-1'`
      ).first()
    ).resolves.toEqual({
      provider_user_id: " subject-with-significant-spaces ",
    });
  });

  it("resolves a bounded provider email set without one D1 binding or statement per email", async () => {
    const ids = ["user-1", "identity-1"];
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
    });
    const verifiedEmails = Array.from({ length: 101 }, (_, index) => `person-${index}@example.com`);

    await expect(
      service.resolve({
        identity: {
          provider: "google",
          issuer: "https://accounts.google.com",
          subject: "google-many-emails",
          verifiedEmails,
          primaryEmail: verifiedEmails[0],
        },
        credential: null,
      })
    ).resolves.toMatchObject({
      userId: "user-1",
      providerIdentityId: "identity-1",
      isNewUser: true,
      collisionCount: 0,
    });

    await expect(
      service.resolve({
        identity: {
          provider: "google",
          issuer: "https://accounts.google.com",
          subject: "google-many-emails",
          verifiedEmails,
          primaryEmail: verifiedEmails[0],
        },
        credential: null,
      })
    ).resolves.toMatchObject({
      userId: "user-1",
      providerIdentityId: "identity-1",
      isNewUser: false,
      collisionCount: 0,
    });

    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM verified_email_claims").first()
    ).resolves.toEqual({ count: 101 });
  });

  it("rejects an unbounded provider email set before writing identity state", async () => {
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => crypto.randomUUID() },
    });
    const verifiedEmails = Array.from(
      { length: 1_001 },
      (_, index) => `person-${index}@example.com`
    );

    await expect(
      service.resolve({
        identity: {
          provider: "google",
          issuer: "https://accounts.google.com",
          subject: "google-too-many-emails",
          verifiedEmails,
          primaryEmail: verifiedEmails[0],
        },
        credential: null,
      })
    ).rejects.toBeInstanceOf(InvalidProviderIdentityEvidenceError);

    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM users) AS users,
           (SELECT count(*) FROM user_identities) AS identities,
           (SELECT count(*) FROM verified_email_claims) AS claims`
      ).first()
    ).resolves.toEqual({ users: 0, identities: 0, claims: 0 });
  });

  it("converges concurrent callbacks for the same immutable subject", async () => {
    function service(userId: string, identityId: string) {
      const ids = [userId, identityId];
      return createIdentityResolver({
        clock: { now: () => NOW_MS },
        idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
      });
    }
    const evidence = {
      identity: {
        provider: "google" as const,
        issuer: "https://accounts.google.com",
        subject: "same-subject",
        verifiedEmails: [],
        primaryEmail: null,
      },
      credential: null,
    };

    const [first, second] = await Promise.all([
      service("user-1", "identity-1").resolve(evidence),
      service("user-2", "identity-2").resolve(evidence),
    ]);

    expect(first.userId).toBe(second.userId);
    expect(first.providerIdentityId).toBe(second.providerIdentityId);
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM users) AS users,
           (SELECT count(*) FROM user_identities) AS identities`
      ).first()
    ).resolves.toEqual({ users: 1, identities: 1 });
  });

  it("advances verification time without rewriting claim provenance", async () => {
    const ids = ["user-1", "identity-1"];
    const initial = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
    });
    const evidence = {
      identity: {
        provider: "google" as const,
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: null,
    };
    await initial.resolve(evidence);

    const later = createIdentityResolver({
      clock: { now: () => NOW_MS + 1_000 },
      idGenerator: { generate: () => "must-not-generate" },
    });
    await later.resolve(evidence);

    await expect(
      env.DB.prepare(
        `SELECT
           source_kind, source_provider_identity_id, created_at, last_verified_at
         FROM verified_email_claims
         WHERE email = 'person@example.com'`
      ).first()
    ).resolves.toEqual({
      source_kind: "provider_verified",
      source_provider_identity_id: "identity-1",
      created_at: NOW_MS,
      last_verified_at: NOW_MS + 1_000,
    });
  });

  it("preserves a legacy canonical reservation when the same user verifies it", async () => {
    const ids = ["user-1", "identity-1"];
    const initial = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
    });
    const evidence = {
      identity: {
        provider: "google" as const,
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: null,
    };
    await initial.resolve(evidence);
    await env.DB.prepare(
      `UPDATE verified_email_claims
       SET source_kind = 'legacy_canonical',
           source_provider_identity_id = NULL,
           last_verified_at = NULL
       WHERE email = 'person@example.com'`
    ).run();

    const later = createIdentityResolver({
      clock: { now: () => NOW_MS + 1_000 },
      idGenerator: { generate: () => "must-not-generate" },
    });
    await expect(later.resolve(evidence)).resolves.toMatchObject({
      userId: "user-1",
      providerIdentityId: "identity-1",
      isNewUser: false,
    });
    await expect(
      env.DB.prepare(
        `SELECT
           source_kind, source_provider_identity_id, created_at, last_verified_at
         FROM verified_email_claims
         WHERE email = 'person@example.com'`
      ).first()
    ).resolves.toEqual({
      source_kind: "legacy_canonical",
      source_provider_identity_id: null,
      created_at: NOW_MS,
      last_verified_at: null,
    });
  });

  it("rejects a stored adapter mismatch without reparenting the subject", async () => {
    const ids = ["user-1", "identity-1"];
    const service = createIdentityResolver({
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => ids.shift() ?? "unexpected-id" },
    });
    const evidence = {
      identity: {
        provider: "google" as const,
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: [],
        primaryEmail: null,
      },
      credential: null,
    };
    await service.resolve(evidence);
    await env.DB.prepare(
      "UPDATE user_identities SET provider = 'github' WHERE id = 'identity-1'"
    ).run();

    let rejection: unknown;
    try {
      await service.resolve(evidence);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ProviderIdentityAdapterMismatchError);
    await expect(
      env.DB.prepare("SELECT user_id FROM user_identities WHERE id = 'identity-1'").first()
    ).resolves.toEqual({ user_id: "user-1" });
  });
});
