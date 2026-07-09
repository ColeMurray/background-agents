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

import { encryptToken, decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  MAX_TOTAL_VALUE_SIZE,
  MAX_SECRETS_PER_SCOPE,
  SecretsValidationError,
  normalizeKey,
  validateKey,
  validateValue,
} from "./secrets-validation";
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
  ): Promise<{ created: number; updated: number; keys: string[] }> {
    const now = Date.now();

    const normalized: Record<string, string> = {};
    let totalValueBytes = 0;
    for (const [rawKey, value] of Object.entries(secrets)) {
      const key = normalizeKey(rawKey);
      validateKey(key);
      validateValue(value);
      totalValueBytes += new TextEncoder().encode(value).length;
      normalized[key] = value;
    }

    if (totalValueBytes > MAX_TOTAL_VALUE_SIZE) {
      throw new SecretsValidationError(`Total secret size exceeds ${MAX_TOTAL_VALUE_SIZE} bytes`);
    }

    const existingKeySet = await this.existingKeys(environmentId);

    const incomingKeys = Object.keys(normalized);
    const netNew = incomingKeys.filter((k) => !existingKeySet.has(k)).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_SCOPE) {
      throw new SecretsValidationError(
        `Environment would exceed ${MAX_SECRETS_PER_SCOPE} secrets limit ` +
          `(current: ${existingKeySet.size}, adding: ${netNew})`
      );
    }

    let created = 0;
    let updated = 0;

    const statements: D1PreparedStatement[] = [];
    for (const [key, value] of Object.entries(normalized)) {
      const encrypted = await encryptToken(value, this.encryptionKey);
      if (existingKeySet.has(key)) updated++;
      else created++;

      statements.push(this.bindUpsert(environmentId, key, encrypted, now));
    }

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

    return (result.results || []).map((row) => ({
      key: row.key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getDecryptedSecrets(environmentId: string): Promise<Record<string, string>> {
    const result = await this.db
      .prepare("SELECT key, encrypted_value FROM environment_secrets WHERE environment_id = ?")
      .bind(environmentId)
      .all<{ key: string; encrypted_value: string }>();

    const rows = result.results || [];
    const decryptedEntries = await Promise.all(
      rows.map(async (row) => {
        try {
          const decryptedValue = await decryptToken(row.encrypted_value, this.encryptionKey);
          return [row.key, decryptedValue] as const;
        } catch (e) {
          log.error("Failed to decrypt secret", {
            environment_id: environmentId,
            key: row.key,
            error: e instanceof Error ? e.message : String(e),
          });
          throw new Error(`Failed to decrypt secret '${row.key}'`);
        }
      })
    );

    return Object.fromEntries(decryptedEntries);
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
   * per-scope key cap; the combined-value byte cap is left to the session-target
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
  ): Promise<{ created: number; updated: number; keys: string[] }> {
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
    const netNew = rows.filter((r) => !existingKeySet.has(r.key)).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_SCOPE) {
      throw new SecretsValidationError(
        `Environment would exceed ${MAX_SECRETS_PER_SCOPE} secrets limit ` +
          `(current: ${existingKeySet.size}, adding: ${netNew})`
      );
    }

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
