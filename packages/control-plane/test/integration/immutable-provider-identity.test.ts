import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  AccountLinkRequiredError,
  ImmutableProviderIdentityService,
  InvalidProviderIdentityEvidenceError,
  ProviderIdentityAdapterMismatchError,
  type ProviderIdentityEvidence,
} from "../../src/auth/immutable-provider-identity";
import { ProviderCredentialStore } from "../../src/db/provider-credentials";
import { cleanD1Tables } from "./cleanup";

const NOW_MS = 1_800_000_000_000;

describe("ImmutableProviderIdentityService", () => {
  beforeEach(cleanD1Tables);

  it("creates an issuer-qualified canonical identity without requiring email evidence", async () => {
    const ids = ["user-1", "identity-1"];
    const service = new ImmutableProviderIdentityService(env.DB, {
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
    const service = new ImmutableProviderIdentityService(env.DB, {
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
    const service = new ImmutableProviderIdentityService(env.DB, {
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
    });
    await service.resolve({
      identity: {
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["google@example.com"],
        primaryEmail: "google@example.com",
      },
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

  it("uses claim uniqueness as the concurrency authority", async () => {
    const github = new ImmutableProviderIdentityService(env.DB, {
      clock: { now: () => NOW_MS },
      idGenerator: {
        generate: (() => {
          const ids = ["github-user", "github-identity"];
          return () => ids.shift() ?? "unexpected-github-id";
        })(),
      },
    });
    const google = new ImmutableProviderIdentityService(env.DB, {
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
      }),
      google.resolve({
        identity: {
          provider: "google",
          issuer: "https://accounts.google.com",
          subject: "google-subject",
          verifiedEmails: ["same@example.com"],
          primaryEmail: "same@example.com",
        },
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
    const service = new ImmutableProviderIdentityService(env.DB, {
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
      providerCredential: {
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

  it("rolls back identity creation when credential preparation fails", async () => {
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
    const service = new ImmutableProviderIdentityService(env.DB, {
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
        providerCredential: {
          kind: "access_only_nonexpiring",
          accessToken: "ghu_access",
        },
      })
    ).rejects.toThrow("cipher unavailable");
    await expect(env.DB.prepare("SELECT count(*) AS count FROM users").first()).resolves.toEqual({
      count: 0,
    });
  });

  it("rejects an issuer that was not selected by the configured provider adapter", async () => {
    const service = new ImmutableProviderIdentityService(env.DB, {
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
      })
    ).rejects.toBeInstanceOf(InvalidProviderIdentityEvidenceError);
  });

  it("preserves the provider subject exactly", async () => {
    const ids = ["user-1", "identity-1"];
    const service = new ImmutableProviderIdentityService(env.DB, {
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
    const service = new ImmutableProviderIdentityService(env.DB, {
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
    const service = new ImmutableProviderIdentityService(env.DB, {
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

  it("rejects provider credentials attached to a Google identity at runtime", async () => {
    const service = new ImmutableProviderIdentityService(env.DB, {
      clock: { now: () => NOW_MS },
      idGenerator: { generate: () => crypto.randomUUID() },
    });
    const malformedEvidence = {
      identity: {
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      providerCredential: {
        kind: "access_only_nonexpiring",
        accessToken: "must-not-store",
      },
    } as unknown as ProviderIdentityEvidence;

    await expect(service.resolve(malformedEvidence)).rejects.toBeInstanceOf(
      InvalidProviderIdentityEvidenceError
    );
  });

  it("converges concurrent callbacks for the same immutable subject", async () => {
    function service(userId: string, identityId: string) {
      const ids = [userId, identityId];
      return new ImmutableProviderIdentityService(env.DB, {
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
    const initial = new ImmutableProviderIdentityService(env.DB, {
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
    };
    await initial.resolve(evidence);

    const later = new ImmutableProviderIdentityService(env.DB, {
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
    const initial = new ImmutableProviderIdentityService(env.DB, {
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
    };
    await initial.resolve(evidence);
    await env.DB.prepare(
      `UPDATE verified_email_claims
       SET source_kind = 'legacy_canonical',
           source_provider_identity_id = NULL,
           last_verified_at = NULL
       WHERE email = 'person@example.com'`
    ).run();

    const later = new ImmutableProviderIdentityService(env.DB, {
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
    const service = new ImmutableProviderIdentityService(env.DB, {
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
