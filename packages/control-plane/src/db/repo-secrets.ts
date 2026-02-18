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

export type { SecretMetadata } from "./secrets-validation";

const log = createLogger("repo-secrets");

export class RepoSecretsStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  async setSecrets(
    repoId: number,
    repoOwner: string,
    repoName: string,
    secrets: Record<string, string>
  ): Promise<{ created: number; updated: number; keys: string[] }> {
    const owner = repoOwner.toLowerCase();
    const name = repoName.toLowerCase();
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
      .prepare("SELECT key FROM repo_secrets WHERE repo_id = ?")
      .bind(repoId)
      .all<{ key: string }>();
    const existingKeySet = new Set((existingKeys.results || []).map((r) => r.key));

    const incomingKeys = Object.keys(normalized);
    const netNew = incomingKeys.filter((k) => !existingKeySet.has(k)).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_SCOPE) {
      throw new SecretsValidationError(
        `Repository would exceed ${MAX_SECRETS_PER_SCOPE} secrets limit ` +
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
            `INSERT INTO repo_secrets
             (repo_id, repo_owner, repo_name, key, encrypted_value, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(repo_id, key) DO UPDATE SET
               repo_owner = excluded.repo_owner,
               repo_name = excluded.repo_name,
               encrypted_value = excluded.encrypted_value,
               updated_at = excluded.updated_at`
          )
          .bind(repoId, owner, name, key, encrypted, now, now)
      );
    }

    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return { created, updated, keys: incomingKeys };
  }

  async listSecretKeys(repoId: number): Promise<SecretMetadata[]> {
    const result = await this.db
      .prepare(
        "SELECT key, created_at, updated_at FROM repo_secrets WHERE repo_id = ? ORDER BY key"
      )
      .bind(repoId)
      .all<{ key: string; created_at: number; updated_at: number }>();

    return (result.results || []).map((row) => ({
      key: row.key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getDecryptedSecrets(repoId: number): Promise<Record<string, string>> {
    const result = await this.db
      .prepare("SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = ?")
      .bind(repoId)
      .all<{ key: string; encrypted_value: string }>();

    const rows = result.results || [];
    const decryptedEntries = await Promise.all(
      rows.map(async (row) => {
        try {
          const decryptedValue = await decryptToken(row.encrypted_value, this.encryptionKey);
          return [row.key, decryptedValue] as const;
        } catch (e) {
          log.error("Failed to decrypt secret", {
            repo_id: repoId,
            key: row.key,
            error: e instanceof Error ? e.message : String(e),
          });
          throw new Error(`Failed to decrypt secret '${row.key}'`);
        }
      })
    );

    return Object.fromEntries(decryptedEntries);
  }

  async deleteSecret(repoId: number, key: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM repo_secrets WHERE repo_id = ? AND key = ?")
      .bind(repoId, normalizeKey(key))
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }
}
