import { DurableObjectOAuthClientProvider } from "agents/mcp/do-oauth-client-provider";
import type { SqlDatabase } from "../db/sql-database";
import { createStaticMcpOAuthKeyring, type McpOAuthKeyring } from "./oauth-keyring";

const AES_GCM = "AES-GCM";
const AES_GCM_IV_BYTES = 12;

function decodeCiphertext(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encodeCiphertext(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

interface OAuthStorageRow {
  storage_key: string;
  ciphertext: string;
}

/**
 * The four-method storage surface used by Agents 0.28.1's
 * DurableObjectOAuthClientProvider. D1 is the credential authority; the MCP
 * connection DO's SQLite never receives these values.
 */
export class D1McpOAuthStorage {
  private readonly resolveKeyring: () => Promise<McpOAuthKeyring>;

  constructor(
    private readonly db: SqlDatabase,
    keyring: McpOAuthKeyring | string | (() => Promise<McpOAuthKeyring>),
    private readonly connectionId: string
  ) {
    if (!/^mcpconn_[a-f0-9]{32}$/.test(connectionId)) {
      throw new Error("MCP OAuth storage requires a logical MCP connection id");
    }
    this.resolveKeyring = async () =>
      typeof keyring === "string"
        ? createStaticMcpOAuthKeyring(keyring)
        : typeof keyring === "function"
          ? await keyring()
          : keyring;
  }

  private additionalData(keyId: string, storageKey: string): Uint8Array {
    return new TextEncoder().encode(
      `open-inspect:mcp-oauth:v1:${keyId}:${this.connectionId}:${storageKey}`
    );
  }

  private async encrypt(storageKey: string, value: unknown): Promise<string> {
    const active = await (await this.resolveKeyring()).active();
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const encrypted = await crypto.subtle.encrypt(
      { name: AES_GCM, iv, additionalData: this.additionalData(active.keyId, storageKey) },
      active.key,
      plaintext
    );
    const envelope = new Uint8Array(iv.length + encrypted.byteLength);
    envelope.set(iv);
    envelope.set(new Uint8Array(encrypted), iv.length);
    return encodeCiphertext(envelope);
  }

  /**
   * Decrypt one value.
   *
   * The key that encrypted the value is tried first, and the retired keys are
   * tried after it, so a rotation never strands existing material.
   */
  private async decrypt<T>(storageKey: string, ciphertext: string): Promise<T> {
    const envelope = decodeCiphertext(ciphertext);
    const iv = envelope.slice(0, AES_GCM_IV_BYTES);
    const encrypted = envelope.slice(AES_GCM_IV_BYTES);
    for (const candidate of await (await this.resolveKeyring()).decryptable()) {
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: AES_GCM, iv, additionalData: this.additionalData(candidate.keyId, storageKey) },
          candidate.key,
          encrypted
        );
        return JSON.parse(new TextDecoder().decode(plaintext)) as T;
      } catch {
        // This key did not encrypt the value. Try the next one.
      }
    }
    throw new Error("MCP OAuth material could not be decrypted with any known key");
  }

  async get<T>(key: string): Promise<T | undefined> {
    const row = await this.db
      .prepare(
        "SELECT ciphertext FROM mcp_oauth_storage WHERE connection_id = ? AND storage_key = ?"
      )
      .bind(this.connectionId, key)
      .first<Pick<OAuthStorageRow, "ciphertext">>();
    if (!row) return undefined;
    return this.decrypt<T>(key, row.ciphertext);
  }

  async put<T>(key: string, value: T): Promise<void> {
    const ciphertext = await this.encrypt(key, value);
    await this.db
      .prepare(
        `INSERT INTO mcp_oauth_storage (connection_id, storage_key, ciphertext, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id, storage_key) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           updated_at = excluded.updated_at`
      )
      .bind(this.connectionId, key, ciphertext, Date.now())
      .run();
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    const keys = Array.isArray(keyOrKeys) ? [...new Set(keyOrKeys)] : [keyOrKeys];
    let deleted = false;
    for (const key of keys) {
      const result = await this.db
        .prepare("DELETE FROM mcp_oauth_storage WHERE connection_id = ? AND storage_key = ?")
        .bind(this.connectionId, key)
        .run();
      deleted ||= (result.meta?.changes ?? 0) > 0;
    }
    return deleted;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    const result = await this.db
      .prepare(
        `SELECT storage_key, ciphertext FROM mcp_oauth_storage
         WHERE connection_id = ? AND substr(storage_key, 1, ?) = ?
         ORDER BY storage_key`
      )
      .bind(this.connectionId, prefix.length, prefix)
      .all<OAuthStorageRow>();
    const values = new Map<string, T>();
    for (const row of result.results ?? []) {
      values.set(row.storage_key, await this.decrypt<T>(row.storage_key, row.ciphertext));
    }
    return values;
  }
}

/** Agents 0.28.1 OAuth state/PKCE behavior backed by the encrypted D1 adapter. */
export class EncryptedMcpOAuthClientProvider extends DurableObjectOAuthClientProvider {
  constructor(options: { storage: D1McpOAuthStorage; clientName: string; callbackUrl: string }) {
    // Agents consumes only get/put/delete/list here. Its public constructor is
    // typed as the full platform storage object even though the provider does
    // not use SQL, alarms, transactions, or sync APIs.
    super(
      options.storage as unknown as DurableObjectStorage,
      options.clientName,
      options.callbackUrl
    );
  }
}
