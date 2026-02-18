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

const log = createLogger("global-secrets");

export class GlobalSecretsStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  async setSecrets(
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

    const existingKeys = await this.db
      .prepare("SELECT key FROM global_secrets")
      .all<{ key: string }>();
    const existingKeySet = new Set((existingKeys.results || []).map((r) => r.key));

    const incomingKeys = Object.keys(normalized);
    const netNew = incomingKeys.filter((k) => !existingKeySet.has(k)).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_SCOPE) {
      throw new SecretsValidationError(
        `Global secrets would exceed ${MAX_SECRETS_PER_SCOPE} secrets limit ` +
          `(current: ${existingKeySet.size}, adding: ${netNew})`
      );
    }

    let created = 0;
    let updated = 0;

    const statements: D1PreparedStatement[] = [];
    for (const [key, value] of Object.entries(normalized)) {
      const encrypted = await encryptToken(value, this.encryptionKey);
      const isNew = !existingKeySet.has(key);
      if (isNew) created++;
      else updated++;

      statements.push(
        this.db
          .prepare(
            `INSERT INTO global_secrets (key, encrypted_value, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               encrypted_value = excluded.encrypted_value,
               updated_at = excluded.updated_at`
          )
          .bind(key, encrypted, now, now)
      );
    }

    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return { created, updated, keys: incomingKeys };
  }

  async listSecretKeys(): Promise<SecretMetadata[]> {
    const result = await this.db
      .prepare("SELECT key, created_at, updated_at FROM global_secrets ORDER BY key")
      .all<{ key: string; created_at: number; updated_at: number }>();

    return (result.results || []).map((row) => ({
      key: row.key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getDecryptedSecrets(): Promise<Record<string, string>> {
    const result = await this.db
      .prepare("SELECT key, encrypted_value FROM global_secrets")
      .all<{ key: string; encrypted_value: string }>();

    const secrets: Record<string, string> = {};
    for (const row of result.results || []) {
      try {
        secrets[row.key] = await decryptToken(row.encrypted_value, this.encryptionKey);
      } catch (e) {
        log.error("Failed to decrypt global secret", {
          key: row.key,
          error: e instanceof Error ? e.message : String(e),
        });
        throw new Error(`Failed to decrypt global secret '${row.key}'`);
      }
    }

    return secrets;
  }

  async deleteSecret(key: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM global_secrets WHERE key = ?")
      .bind(normalizeKey(key))
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }
}
