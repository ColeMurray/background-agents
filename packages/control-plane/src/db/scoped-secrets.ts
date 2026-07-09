/**
 * Shared plumbing for the scoped-secrets D1 stores (global-secrets,
 * repo-secrets, environment-secrets). This module owns only the
 * scope-independent pieces — write validation, the per-scope key cap,
 * value encryption bookkeeping, and row codecs. Each store keeps its own
 * table-specific SQL and public API; none of the stored/encrypted formats
 * change (all scopes encrypt with REPO_SECRETS_ENCRYPTION_KEY, as before).
 */

import { encryptToken, decryptToken } from "../auth/crypto";
import {
  MAX_TOTAL_VALUE_SIZE,
  MAX_SECRETS_PER_SCOPE,
  SecretsValidationError,
  normalizeKey,
  validateKey,
  validateValue,
} from "./secrets-validation";
import type { SecretMetadata } from "./secrets-validation";

/** Result shape shared by every scoped-secrets write (set/import). */
export interface SecretsWriteResult {
  created: number;
  updated: number;
  keys: string[];
}

/**
 * Normalize keys, validate every entry, and enforce the combined-value byte
 * cap. Returns the normalized key → plaintext record ready for encryption.
 */
export function prepareSecretsForWrite(secrets: Record<string, string>): Record<string, string> {
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

  return normalized;
}

/**
 * Enforce the per-scope key-count cap for a pending write. `scopeSubject`
 * opens the error message ("Global secrets", "Repository", "Environment").
 */
export function assertScopeKeyCapacity(
  scopeSubject: string,
  existingKeySet: ReadonlySet<string>,
  incomingKeys: readonly string[]
): void {
  const netNew = incomingKeys.filter((k) => !existingKeySet.has(k)).length;
  if (existingKeySet.size + netNew > MAX_SECRETS_PER_SCOPE) {
    throw new SecretsValidationError(
      `${scopeSubject} would exceed ${MAX_SECRETS_PER_SCOPE} secrets limit ` +
        `(current: ${existingKeySet.size}, adding: ${netNew})`
    );
  }
}

/**
 * Encrypt each value and tally created vs updated against the scope's
 * existing key set. The store binds the returned entries into its own
 * table-specific upsert statements.
 */
export async function encryptSecretEntries(
  normalized: Record<string, string>,
  existingKeySet: ReadonlySet<string>,
  encryptionKey: string
): Promise<{
  entries: Array<{ key: string; encryptedValue: string }>;
  created: number;
  updated: number;
}> {
  const entries: Array<{ key: string; encryptedValue: string }> = [];
  let created = 0;
  let updated = 0;
  for (const [key, value] of Object.entries(normalized)) {
    if (existingKeySet.has(key)) updated++;
    else created++;
    entries.push({ key, encryptedValue: await encryptToken(value, encryptionKey) });
  }
  return { entries, created, updated };
}

/** Map `key, created_at, updated_at` rows to the wire metadata shape. */
export function toSecretMetadata(
  rows: Array<{ key: string; created_at: number; updated_at: number }>
): SecretMetadata[] {
  return rows.map((row) => ({
    key: row.key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

interface SecretsDecryptLog {
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Decrypt `key, encrypted_value` rows into a key → plaintext record. On
 * failure, logs (never the value) and throws. `noun` names the scope in the
 * message ("secret" by default, "global secret" for the global scope);
 * `logContext` adds scope identifiers such as repo_id or environment_id.
 */
export async function decryptSecretRows(params: {
  rows: Array<{ key: string; encrypted_value: string }>;
  encryptionKey: string;
  log: SecretsDecryptLog;
  noun?: string;
  logContext?: Record<string, unknown>;
}): Promise<Record<string, string>> {
  const { rows, encryptionKey, log, noun = "secret", logContext = {} } = params;
  const decryptedEntries = await Promise.all(
    rows.map(async (row) => {
      try {
        const decryptedValue = await decryptToken(row.encrypted_value, encryptionKey);
        return [row.key, decryptedValue] as const;
      } catch (e) {
        log.error(`Failed to decrypt ${noun}`, {
          ...logContext,
          key: row.key,
          error: e instanceof Error ? e.message : String(e),
        });
        throw new Error(`Failed to decrypt ${noun} '${row.key}'`);
      }
    })
  );

  return Object.fromEntries(decryptedEntries);
}
