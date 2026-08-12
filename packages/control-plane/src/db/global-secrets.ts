import { createLogger } from "../logger";
import {
  SecretDecryptionError,
  assertScopeKeyCapacity,
  decryptSecretRows,
  decryptStoredSecret,
  encryptSecretEntries,
  encryptSecretValue,
  prepareSecretsForWrite,
  toSecretMetadata,
} from "./scoped-secrets";
import type { SecretsWriteResult, StoredSecretValue } from "./scoped-secrets";
import { normalizeKey } from "./secrets-validation";
import type { SecretMetadata } from "./secrets-validation";
import type { SqlDatabase } from "./sql-database";

const log = createLogger("global-secrets");

export class GlobalSecretsStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async setSecrets(secrets: Record<string, string>): Promise<SecretsWriteResult> {
    const now = Date.now();
    const normalized = prepareSecretsForWrite(secrets);

    const existingKeys = await this.db
      .prepare("SELECT key FROM global_secrets")
      .all<{ key: string }>();
    const existingKeySet = new Set((existingKeys.results || []).map((r) => r.key));

    const incomingKeys = Object.keys(normalized);
    assertScopeKeyCapacity("Global secrets", existingKeySet, incomingKeys);

    const { entries, created, updated } = await encryptSecretEntries(
      normalized,
      existingKeySet,
      this.encryptionKey
    );

    const statements = entries.map((entry) =>
      this.db
        .prepare(
          `INSERT INTO global_secrets (key, encrypted_value, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             encrypted_value = excluded.encrypted_value,
             updated_at = excluded.updated_at`
        )
        .bind(entry.key, entry.encryptedValue, now, now)
    );

    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return { created, updated, keys: incomingKeys };
  }

  async listSecretKeys(): Promise<SecretMetadata[]> {
    const result = await this.db
      .prepare("SELECT key, created_at, updated_at FROM global_secrets ORDER BY key")
      .all<{ key: string; created_at: number; updated_at: number }>();

    return toSecretMetadata(result.results || []);
  }

  async getDecryptedSecrets(): Promise<Record<string, string>> {
    const result = await this.db
      .prepare("SELECT key, encrypted_value FROM global_secrets")
      .all<{ key: string; encrypted_value: string }>();

    try {
      return await decryptSecretRows(result.results || [], this.encryptionKey);
    } catch (e) {
      if (e instanceof SecretDecryptionError) {
        log.error("Failed to decrypt global secret", {
          key: e.key,
          error: e.cause instanceof Error ? e.cause.message : String(e.cause),
        });
        throw new Error(`Failed to decrypt global secret '${e.key}'`);
      }
      throw e;
    }
  }

  async getSecretWithCiphertext(key: string): Promise<StoredSecretValue | null> {
    const row = await this.db
      .prepare("SELECT encrypted_value FROM global_secrets WHERE key = ?")
      .bind(normalizeKey(key))
      .first<{ encrypted_value: string }>();
    if (!row) return null;

    try {
      return await decryptStoredSecret(key, row.encrypted_value, this.encryptionKey);
    } catch (e) {
      if (e instanceof SecretDecryptionError) {
        log.error("Failed to decrypt global secret", {
          key: e.key,
          error: e.cause instanceof Error ? e.cause.message : String(e.cause),
        });
        throw new Error(`Failed to decrypt global secret '${e.key}'`);
      }
      throw e;
    }
  }

  /**
   * Atomically persist a rotated credential bundle. Every statement in the
   * batch is conditioned on `guardKey` still holding `expectedCiphertext`, and
   * the guard row itself is swapped last, so the whole bundle commits or
   * nothing does. Returns false — having written nothing — when the guard did
   * not match: a concurrent rotation won, or the guard row was deleted.
   */
  async casWriteSecrets(
    guardKey: string,
    expectedCiphertext: string,
    secrets: Record<string, string>
  ): Promise<boolean> {
    const now = Date.now();
    const normalized = prepareSecretsForWrite(secrets);
    const guard = normalizeKey(guardKey);
    const { [guard]: guardValue, ...companionValues } = normalized;
    if (guardValue === undefined) {
      throw new Error(`casWriteSecrets requires secrets to include guard key '${guard}'`);
    }

    const existingKeys = await this.db
      .prepare("SELECT key FROM global_secrets")
      .all<{ key: string }>();
    const existingKeySet = new Set((existingKeys.results || []).map((r) => r.key));
    assertScopeKeyCapacity("Global secrets", existingKeySet, Object.keys(normalized));

    const { entries } = await encryptSecretEntries(
      companionValues,
      existingKeySet,
      this.encryptionKey
    );
    const guardEncrypted = await encryptSecretValue(guardValue, this.encryptionKey);

    const statements = [
      ...entries.map((entry) =>
        this.db
          .prepare(
            `INSERT INTO global_secrets (key, encrypted_value, created_at, updated_at)
             SELECT ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM global_secrets WHERE key = ? AND encrypted_value = ?)
             ON CONFLICT(key) DO UPDATE SET
               encrypted_value = excluded.encrypted_value,
               updated_at = excluded.updated_at`
          )
          .bind(entry.key, entry.encryptedValue, now, now, guard, expectedCiphertext)
      ),
      this.db
        .prepare(
          `UPDATE global_secrets
           SET encrypted_value = ?, updated_at = ?
           WHERE key = ? AND encrypted_value = ?`
        )
        .bind(guardEncrypted, now, guard, expectedCiphertext),
    ];

    const results = await this.db.batch(statements);
    return (results[results.length - 1]?.meta?.changes ?? 0) > 0;
  }

  async deleteSecret(key: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM global_secrets WHERE key = ?")
      .bind(normalizeKey(key))
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }
}
