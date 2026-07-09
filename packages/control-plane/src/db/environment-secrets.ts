/**
 * EnvironmentSecretsStore — D1 persistence for environment-scoped secrets.
 *
 * Mirrors RepoSecretsStore exactly (same crypto: REPO_SECRETS_ENCRYPTION_KEY,
 * same validation and per-scope caps), keyed by environment_id instead of
 * repo_id. Environment sessions get global + environment secrets only; member
 * repos' secrets never flow in (design §7.4).
 *
 * The per-key import copies ciphertext VERBATIM from a member repo's stored
 * secrets — because both scopes share one encryption key, no decrypt/re-encrypt
 * round-trip is needed, and plaintext never transits the control plane.
 */

import { createLogger } from "../logger";
import {
  SecretDecryptionError,
  assertScopeKeyCapacity,
  decryptSecretRows,
  encryptSecretEntries,
  prepareSecretsForWrite,
  toSecretMetadata,
} from "./scoped-secrets";
import type { SecretsWriteResult } from "./scoped-secrets";
import { normalizeKey, validateKey } from "./secrets-validation";
import type { SecretMetadata } from "./secrets-validation";

const log = createLogger("environment-secrets");

export class EnvironmentSecretsStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  async setSecrets(
    environmentId: string,
    secrets: Record<string, string>
  ): Promise<SecretsWriteResult> {
    const now = Date.now();
    const normalized = prepareSecretsForWrite(secrets);

    const existingKeySet = await this.existingKeys(environmentId);

    const incomingKeys = Object.keys(normalized);
    assertScopeKeyCapacity("Environment", existingKeySet, incomingKeys);

    const { entries, created, updated } = await encryptSecretEntries(
      normalized,
      existingKeySet,
      this.encryptionKey
    );

    const statements = entries.map((entry) =>
      this.bindUpsert(environmentId, entry.key, entry.encryptedValue, now)
    );

    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return { created, updated, keys: incomingKeys };
  }

  async listSecretKeys(environmentId: string): Promise<SecretMetadata[]> {
    const result = await this.db
      .prepare(
        "SELECT key, created_at, updated_at FROM environment_secrets WHERE environment_id = ? ORDER BY key"
      )
      .bind(environmentId)
      .all<{ key: string; created_at: number; updated_at: number }>();

    return toSecretMetadata(result.results || []);
  }

  async getDecryptedSecrets(environmentId: string): Promise<Record<string, string>> {
    const result = await this.db
      .prepare("SELECT key, encrypted_value FROM environment_secrets WHERE environment_id = ?")
      .bind(environmentId)
      .all<{ key: string; encrypted_value: string }>();

    try {
      return await decryptSecretRows(result.results || [], this.encryptionKey);
    } catch (e) {
      if (e instanceof SecretDecryptionError) {
        log.error("Failed to decrypt secret", {
          environment_id: environmentId,
          key: e.key,
          error: e.cause instanceof Error ? e.cause.message : String(e.cause),
        });
        throw new Error(`Failed to decrypt secret '${e.key}'`);
      }
      throw e;
    }
  }

  async deleteSecret(environmentId: string, key: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM environment_secrets WHERE environment_id = ? AND key = ?")
      .bind(environmentId, normalizeKey(key))
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Copy secrets from a member repo into this environment, ciphertext-verbatim.
   * When `keys` is omitted, imports every key the source repo has. Enforces the
   * per-scope key cap; the combined-value byte cap is left to the launch-unit
   * fold at spawn/build time (PR-6) since measuring it here would require
   * decrypting the copied ciphertext.
   *
   * @param sourceRepoId repo_id of a repo the caller has already verified to be
   *   a current member of the environment (authorization is a route concern).
   */
  async importFromRepo(
    environmentId: string,
    sourceRepoId: number,
    keys?: string[]
  ): Promise<SecretsWriteResult> {
    let query = "SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = ?";
    const binds: unknown[] = [sourceRepoId];

    if (keys !== undefined) {
      const normalizedKeys = keys.map(normalizeKey);
      normalizedKeys.forEach(validateKey);
      if (normalizedKeys.length === 0) return { created: 0, updated: 0, keys: [] };
      query += ` AND key IN (${normalizedKeys.map(() => "?").join(", ")})`;
      binds.push(...normalizedKeys);
    }

    const source = await this.db
      .prepare(query)
      .bind(...binds)
      .all<{ key: string; encrypted_value: string }>();
    const rows = source.results || [];
    if (rows.length === 0) return { created: 0, updated: 0, keys: [] };

    const existingKeySet = await this.existingKeys(environmentId);
    assertScopeKeyCapacity(
      "Environment",
      existingKeySet,
      rows.map((r) => r.key)
    );

    const now = Date.now();
    let created = 0;
    let updated = 0;
    const statements = rows.map((row) => {
      if (existingKeySet.has(row.key)) updated++;
      else created++;
      return this.bindUpsert(environmentId, row.key, row.encrypted_value, now);
    });

    await this.db.batch(statements);
    return { created, updated, keys: rows.map((r) => r.key) };
  }

  private async existingKeys(environmentId: string): Promise<Set<string>> {
    const existing = await this.db
      .prepare("SELECT key FROM environment_secrets WHERE environment_id = ?")
      .bind(environmentId)
      .all<{ key: string }>();
    return new Set((existing.results || []).map((r) => r.key));
  }

  private bindUpsert(
    environmentId: string,
    key: string,
    encryptedValue: string,
    now: number
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO environment_secrets
         (environment_id, key, encrypted_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(environment_id, key) DO UPDATE SET
           encrypted_value = excluded.encrypted_value,
           updated_at = excluded.updated_at`
      )
      .bind(environmentId, key, encryptedValue, now, now);
  }
}
