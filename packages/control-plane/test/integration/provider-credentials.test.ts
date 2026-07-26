import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ProviderCredentialCipher } from "../../src/auth/auth-encryption";
import type { ProviderCredentialCipherPort } from "../../src/auth/provider-credential-cipher";
import {
  PROVIDER_CREDENTIAL_ROW_VERSION_CHECK,
  ProviderCredentialStore,
  ProviderCredentialVersionConflictError,
  StoredProviderCredentialCorruptError,
} from "../../src/db/provider-credentials";
import { cleanD1Tables } from "./cleanup";

const NOW_MS = 1_800_000_000_000;
const ROOT_KEY_BASE64 = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex"
).toString("base64");

describe("ProviderCredentialStore", () => {
  let store: ProviderCredentialStore;

  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
         VALUES ('user-1', NULL, NULL, NULL, ?, ?)`
      ).bind(NOW_MS, NOW_MS),
      env.DB.prepare(
        `INSERT INTO user_identities
         (id, user_id, provider, provider_issuer, provider_user_id, created_at)
         VALUES (
           'identity-1', 'user-1', 'github', 'https://github.com',
           'github-subject', ?
         )`
      ).bind(NOW_MS),
    ]);
    store = new ProviderCredentialStore(env.DB, new ProviderCredentialCipher(ROOT_KEY_BASE64), {
      now: () => NOW_MS,
    });
  });

  it("pins the row-version check used to detect stale sign-in writes", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO provider_credentials (
           provider_identity_id, credential_kind,
           access_token_ciphertext, access_expires_at,
           refresh_token_ciphertext, refresh_expires_at,
           encryption_key_version, row_version, updated_at
         ) VALUES (?, 'access_only_nonexpiring', ?, NULL, NULL, NULL, 1, 0, ?)`
      )
        .bind("identity-1", "ciphertext", NOW_MS)
        .run()
    ).rejects.toThrow(`CHECK constraint failed: ${PROVIDER_CREDENTIAL_ROW_VERSION_CHECK}`);
  });

  it("round-trips refreshable credentials without storing plaintext tokens", async () => {
    await expect(
      store.upsertFromSignIn("identity-1", {
        kind: "refreshable",
        accessToken: "github-access-token",
        accessExpiresAt: NOW_MS + 60_000,
        refreshToken: "github-refresh-token",
        refreshExpiresAt: null,
      })
    ).resolves.toBe(1);
    await expect(store.get("identity-1")).resolves.toEqual({
      providerIdentityId: "identity-1",
      kind: "refreshable",
      accessToken: "github-access-token",
      accessExpiresAt: NOW_MS + 60_000,
      refreshToken: "github-refresh-token",
      refreshExpiresAt: null,
      encryptionKeyVersion: 1,
      rowVersion: 1,
      updatedAt: NOW_MS,
    });

    const persisted = await env.DB.prepare(
      `SELECT access_token_ciphertext, refresh_token_ciphertext
       FROM provider_credentials
       WHERE provider_identity_id = 'identity-1'`
    ).first();
    expect(JSON.stringify(persisted)).not.toContain("github-access-token");
    expect(JSON.stringify(persisted)).not.toContain("github-refresh-token");
  });

  it("does not let stale invalidation delete credentials from a newer sign-in", async () => {
    const firstVersion = await store.upsertFromSignIn("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "old-access-token",
    });

    const secondVersion = await store.upsertFromSignIn("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "new-access-token",
    });

    await expect(store.invalidateObservedVersion("identity-1", firstVersion)).resolves.toBe(false);
    await expect(store.get("identity-1")).resolves.toMatchObject({
      accessToken: "new-access-token",
      rowVersion: secondVersion,
    });
  });

  it("serializes concurrent sign-ins through row-version retries", async () => {
    const versions = await Promise.all([
      store.upsertFromSignIn("identity-1", {
        kind: "access_only_nonexpiring",
        accessToken: "first-concurrent-token",
      }),
      store.upsertFromSignIn("identity-1", {
        kind: "access_only_nonexpiring",
        accessToken: "second-concurrent-token",
      }),
    ]);

    expect(versions.sort()).toEqual([1, 2]);
    await expect(store.get("identity-1")).resolves.toMatchObject({
      rowVersion: 2,
    });
  });

  it("does not let a stale refresh overwrite credentials from a newer sign-in", async () => {
    const observedVersion = await store.upsertFromSignIn("identity-1", {
      kind: "refreshable",
      accessToken: "expired-access-token",
      accessExpiresAt: NOW_MS - 1,
      refreshToken: "refresh-token",
      refreshExpiresAt: null,
    });
    const signInVersion = await store.upsertFromSignIn("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "new-sign-in-token",
    });

    await expect(
      store.replaceObservedVersion("identity-1", observedVersion, {
        kind: "refreshable",
        accessToken: "stale-refresh-access-token",
        accessExpiresAt: NOW_MS + 60_000,
        refreshToken: "stale-refresh-token",
        refreshExpiresAt: null,
      })
    ).rejects.toBeInstanceOf(ProviderCredentialVersionConflictError);
    await expect(store.get("identity-1")).resolves.toMatchObject({
      accessToken: "new-sign-in-token",
      rowVersion: signInVersion,
    });
  });

  it("replaces the exact credential version observed by a provider refresh", async () => {
    const observedVersion = await store.upsertFromSignIn("identity-1", {
      kind: "refreshable",
      accessToken: "expired-access-token",
      accessExpiresAt: NOW_MS - 1,
      refreshToken: "refresh-token",
      refreshExpiresAt: null,
    });

    await expect(
      store.replaceObservedVersion("identity-1", observedVersion, {
        kind: "refreshable",
        accessToken: "refreshed-access-token",
        accessExpiresAt: NOW_MS + 60_000,
        refreshToken: "rotated-refresh-token",
        refreshExpiresAt: NOW_MS + 120_000,
      })
    ).resolves.toBe(2);
    await expect(store.get("identity-1")).resolves.toMatchObject({
      accessToken: "refreshed-access-token",
      refreshToken: "rotated-refresh-token",
      refreshExpiresAt: NOW_MS + 120_000,
      rowVersion: 2,
    });
  });

  it("supports both current access-only credential shapes", async () => {
    await store.upsertFromSignIn("identity-1", {
      kind: "access_only_expiring",
      accessToken: "expiring-access-token",
      accessExpiresAt: NOW_MS + 60_000,
    });
    await expect(store.get("identity-1")).resolves.toMatchObject({
      kind: "access_only_expiring",
      accessToken: "expiring-access-token",
      accessExpiresAt: NOW_MS + 60_000,
      rowVersion: 1,
    });

    await store.upsertFromSignIn("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "nonexpiring-access-token",
    });
    await expect(store.get("identity-1")).resolves.toEqual({
      providerIdentityId: "identity-1",
      kind: "access_only_nonexpiring",
      accessToken: "nonexpiring-access-token",
      encryptionKeyVersion: 1,
      rowVersion: 2,
      updatedAt: NOW_MS,
    });
  });

  it("fails closed when ciphertext is moved to a different row version", async () => {
    await store.upsertFromSignIn("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "access-token",
    });
    await env.DB.prepare(
      `UPDATE provider_credentials
       SET row_version = 2
       WHERE provider_identity_id = 'identity-1'`
    ).run();

    await expect(store.get("identity-1")).rejects.toBeInstanceOf(
      StoredProviderCredentialCorruptError
    );
  });

  it("composes initial credential creation into an identity-owned atomic batch", async () => {
    const credentialInsert = await store.prepareInitialInsert("identity-2", {
      kind: "access_only_nonexpiring",
      accessToken: "new-identity-access-token",
    });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
         VALUES ('user-2', NULL, NULL, NULL, ?, ?)`
      ).bind(NOW_MS, NOW_MS),
      env.DB.prepare(
        `INSERT INTO user_identities
         (id, user_id, provider, provider_issuer, provider_user_id, created_at)
         VALUES (
           'identity-2', 'user-2', 'github', 'https://github.com',
           'github-subject-2', ?
         )`
      ).bind(NOW_MS),
      credentialInsert,
    ]);

    await expect(store.get("identity-2")).resolves.toMatchObject({
      providerIdentityId: "identity-2",
      accessToken: "new-identity-access-token",
      rowVersion: 1,
    });
  });

  it("makes a stale prepared sign-in mutation fail its caller-owned batch atomically", async () => {
    await store.upsertFromSignIn("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "initial-access-token",
    });
    const staleCredentialMutation = await store.prepareSignInUpsert("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "stale-sign-in-token",
    });
    await store.upsertFromSignIn("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "concurrent-sign-in-token",
    });

    let rejection: unknown;
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET display_name = 'must-roll-back' WHERE id = 'user-1'"),
        staleCredentialMutation,
      ]);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(store.isSignInVersionConflict(rejection)).toBe(true);
    await expect(
      env.DB.prepare("SELECT display_name FROM users WHERE id = 'user-1'").first()
    ).resolves.toEqual({ display_name: null });
    await expect(store.get("identity-1")).resolves.toMatchObject({
      accessToken: "concurrent-sign-in-token",
      rowVersion: 2,
    });
  });

  it("fails closed when authenticated ciphertext decodes to an empty token", async () => {
    const emptyPlaintextCipher: ProviderCredentialCipherPort = {
      encrypt: async () => "authenticated-ciphertext",
      decrypt: async () => "",
    };
    const corruptStore = new ProviderCredentialStore(env.DB, emptyPlaintextCipher, {
      now: () => NOW_MS,
    });
    await corruptStore.upsertFromSignIn("identity-1", {
      kind: "access_only_nonexpiring",
      accessToken: "nonempty-input-token",
    });

    await expect(corruptStore.get("identity-1")).rejects.toBeInstanceOf(
      StoredProviderCredentialCorruptError
    );
  });
});
