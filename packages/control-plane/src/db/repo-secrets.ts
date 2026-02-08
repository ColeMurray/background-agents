import { encryptToken, decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";

const log = createLogger("repo-secrets");

const VALID_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_SIZE = 16384;
const MAX_TOTAL_VALUE_SIZE = 65536;
const MAX_SECRETS_PER_REPO = 50;

const RESERVED_KEYS = new Set([
  "PYTHONUNBUFFERED",
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "SANDBOX_AUTH_TOKEN",
  "REPO_OWNER",
  "REPO_NAME",
  "GITHUB_APP_TOKEN",
  "SESSION_CONFIG",
  "RESTORED_FROM_SNAPSHOT",
  "OPENCODE_CONFIG_CONTENT",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "LANG",
]);

export class RepoSecretsValidationError extends Error {}

export interface SecretMetadata {
  key: string;
  createdAt: number;
  updatedAt: number;
}

export class RepoSecretsStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  normalizeKey(key: string): string {
    return key.toUpperCase();
  }

  validateKey(key: string): void {
    if (!key || key.length > MAX_KEY_LENGTH)
      throw new RepoSecretsValidationError("Key too long or empty");
    if (!VALID_KEY_PATTERN.test(key))
      throw new RepoSecretsValidationError("Key must match [A-Za-z_][A-Za-z0-9_]*");
    if (RESERVED_KEYS.has(key.toUpperCase()))
      throw new RepoSecretsValidationError(`Key '${key}' is reserved`);
  }

  validateValue(value: string): void {
    if (typeof value !== "string") throw new RepoSecretsValidationError("Value must be a string");
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > MAX_VALUE_SIZE)
      throw new RepoSecretsValidationError(`Value exceeds ${MAX_VALUE_SIZE} bytes`);
  }

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
      const key = this.normalizeKey(rawKey);
      this.validateKey(key);
      this.validateValue(value);
      totalValueBytes += new TextEncoder().encode(value).length;
      normalized[key] = value;
    }

    if (totalValueBytes > MAX_TOTAL_VALUE_SIZE) {
      throw new RepoSecretsValidationError(
        `Total secret size exceeds ${MAX_TOTAL_VALUE_SIZE} bytes`
      );
    }

    const existingKeys = await this.db
      .prepare("SELECT key FROM repo_secrets WHERE repo_id = ?")
      .bind(repoId)
      .all<{ key: string }>();
    const existingKeySet = new Set((existingKeys.results || []).map((r) => r.key));

    const incomingKeys = Object.keys(normalized);
    const netNew = incomingKeys.filter((k) => !existingKeySet.has(k)).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_REPO) {
      throw new RepoSecretsValidationError(
        `Repository would exceed ${MAX_SECRETS_PER_REPO} secrets limit ` +
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

    const secrets: Record<string, string> = {};
    for (const row of result.results || []) {
      try {
        secrets[row.key] = await decryptToken(row.encrypted_value, this.encryptionKey);
      } catch (e) {
        log.error("Failed to decrypt secret", {
          repo_id: repoId,
          key: row.key,
          error: e instanceof Error ? e.message : String(e),
        });
        throw new Error(`Failed to decrypt secret '${row.key}'`);
      }
    }

    return secrets;
  }

  async deleteSecret(repoId: number, key: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM repo_secrets WHERE repo_id = ? AND key = ?")
      .bind(repoId, this.normalizeKey(key))
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }
}
