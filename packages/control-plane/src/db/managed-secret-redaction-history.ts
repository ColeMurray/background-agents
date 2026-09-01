import { decryptToken } from "../auth/crypto";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface SecretValueRow {
  encrypted_value: string;
}

export function archiveManagedSecretStatements(
  db: SqlDatabase,
  rows: SecretValueRow[],
  now: number
): SqlStatement[] {
  return rows.map(({ encrypted_value }) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO managed_secret_redaction_history (encrypted_value, created_at)
         VALUES (?, ?)`
      )
      .bind(encrypted_value, now)
  );
}

export async function listCurrentManagedSecretValues(
  db: SqlDatabase,
  encryptionKey: string
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT encrypted_value FROM global_secrets
       UNION ALL SELECT encrypted_value FROM repo_secrets
       UNION ALL SELECT encrypted_value FROM environment_secrets`
    )
    .all<SecretValueRow>();
  return decryptRows(result.results ?? [], encryptionKey);
}

export async function listManagedSecretHistory(
  db: SqlDatabase,
  encryptionKey: string
): Promise<string[]> {
  const result = await db
    .prepare("SELECT encrypted_value FROM managed_secret_redaction_history")
    .all<SecretValueRow>();
  return decryptRows(result.results ?? [], encryptionKey);
}

function decryptRows(rows: SecretValueRow[], encryptionKey: string): Promise<string[]> {
  return Promise.all(
    rows.map(({ encrypted_value }) => decryptToken(encrypted_value, encryptionKey))
  );
}
