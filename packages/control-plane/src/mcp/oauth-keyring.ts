import type { SqlDatabase } from "../db/sql-database";

/**
 * The MCP OAuth keyring.
 *
 * The active key encrypts new material. A retired key stays readable until
 * its material is re-encrypted, so a rotation never strands a live token and
 * never has to be a flag day.
 */
export interface McpOAuthKeyring {
  /** The key that encrypts new material. */
  active(): Promise<McpOAuthKey>;
  /** Every key that may still decrypt existing material, newest first. */
  decryptable(): Promise<McpOAuthKey[]>;
}

export interface McpOAuthKey {
  /** The key's identity. It is part of the additional authenticated data. */
  keyId: string;
  key: CryptoKey;
}

export class McpOAuthKeyringError extends Error {}

const AES_GCM = "AES-GCM";

function importEncryptionKey(keyBase64: string): Promise<CryptoKey> {
  const keyData = Uint8Array.from(atob(keyBase64), (character) => character.charCodeAt(0));
  return crypto.subtle.importKey("raw", keyData, { name: AES_GCM, length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * The keyring kept in D1.
 *
 * D1 is the credential authority, so the key material lives beside the
 * ciphertext it protects and never in the Durable Object's storage.
 */
export class D1McpOAuthKeyring implements McpOAuthKeyring {
  constructor(private readonly db: SqlDatabase) {}

  async active(): Promise<McpOAuthKey> {
    const row = await this.db
      .prepare("SELECT key_id, key_material FROM mcp_oauth_keyring WHERE status = 'active'")
      .first<{ key_id: string; key_material: string }>();
    if (!row) {
      throw new McpOAuthKeyringError("No active MCP OAuth encryption key");
    }
    return { keyId: row.key_id, key: await importEncryptionKey(row.key_material) };
  }

  async decryptable(): Promise<McpOAuthKey[]> {
    const rows = await this.db
      .prepare(
        `SELECT key_id, key_material FROM mcp_oauth_keyring
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC`
      )
      .all<{ key_id: string; key_material: string }>();
    return Promise.all(
      (rows.results ?? []).map(async (row) => ({
        keyId: row.key_id,
        key: await importEncryptionKey(row.key_material),
      }))
    );
  }

  /**
   * Add a new key and retire the previous active one.
   *
   * The retired key stays readable, so the material it protected is still
   * available until it is re-encrypted.
   */
  async rotate(keyId: string, keyMaterial: string, now: number): Promise<boolean> {
    const material = Uint8Array.from(atob(keyMaterial), (character) => character.charCodeAt(0));
    if (material.length !== 32) {
      throw new McpOAuthKeyringError("An MCP OAuth encryption key must be 32 bytes");
    }
    const result = await this.db
      .prepare(
        `UPDATE mcp_oauth_keyring
         SET status = 'retired', retired_at = ?
         WHERE status = 'active'`
      )
      .bind(now)
      .run();
    await this.db
      .prepare(
        `INSERT INTO mcp_oauth_keyring (key_id, key_material, status, created_at, retired_at)
         VALUES (?, ?, 'active', ?, NULL)`
      )
      .bind(keyId, keyMaterial, now)
      .run();
    return (result.meta?.changes ?? 0) >= 0;
  }
}

/** The keyring used when the deployment supplies a single static key. */
export function createStaticMcpOAuthKeyring(keyMaterial: string): McpOAuthKeyring {
  const key = importEncryptionKey(keyMaterial);
  return {
    async active() {
      return { keyId: "static", key: await key };
    },
    async decryptable() {
      return [{ keyId: "static", key: await key }];
    },
  };
}

/**
 * The keyring a deployment actually uses.
 *
 * A rotated keyring in D1 wins, so a rotation takes effect without a code
 * change. A deployment that never rotated keeps its static environment key.
 */
export async function resolveMcpOAuthKeyring(
  db: SqlDatabase,
  staticKeyMaterial: string
): Promise<McpOAuthKeyring> {
  const row = await db
    .prepare("SELECT key_id FROM mcp_oauth_keyring WHERE status = 'active'")
    .first<{ key_id: string }>();
  if (!row) return createStaticMcpOAuthKeyring(staticKeyMaterial);
  return new D1McpOAuthKeyring(db);
}
