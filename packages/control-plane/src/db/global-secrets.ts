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
import { normalizeKey } from "./secrets-validation";
import type { SecretMetadata } from "./secrets-validation";
import type { SqlDatabase } from "./sql-database";
import { archiveManagedSecretStatements } from "./managed-secret-redaction-history";

const log = createLogger("global-secrets");

export class GlobalSecretsStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async setSecrets(secrets: Record<string, unknown>): Promise<SecretsWriteResult> {
    const now = Date.now();
    const normalized = prepareSecretsForWrite(secrets);

    const existingKeys = await this.db
      .prepare("SELECT key, encrypted_value FROM global_secrets")
      .all<{ key: string; encrypted_value: string }>();
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
    const replaced = (existingKeys.results ?? []).filter(({ key }) => key in normalized);

    if (statements.length > 0) {
      await this.db.batch([
        ...archiveManagedSecretStatements(this.db, replaced, now),
        ...statements,
      ]);
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

  async deleteSecret(key: string): Promise<boolean> {
    const normalized = normalizeKey(key);
    const existing = (
      await this.db
        .prepare("SELECT key, encrypted_value FROM global_secrets")
        .all<{ key: string; encrypted_value: string }>()
    ).results?.find(({ key: candidate }) => candidate === normalized);
    if (!existing) return false;
    const [, result] = await this.db.batch([
      ...archiveManagedSecretStatements(this.db, [existing], Date.now()),
      this.db.prepare("DELETE FROM global_secrets WHERE key = ?").bind(normalized),
    ]);

    return (result.meta?.changes ?? 0) > 0;
  }
}
