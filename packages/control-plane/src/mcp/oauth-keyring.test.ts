import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { D1McpOAuthKeyring, McpOAuthKeyringError } from "./oauth-keyring";

function keyMaterial(seed: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(seed)));
}

describe("McpOAuthKeyring", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE mcp_oauth_keyring (
        key_id TEXT PRIMARY KEY,
        key_material TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        retired_at INTEGER
      );
      CREATE UNIQUE INDEX idx_mcp_oauth_keyring_active ON mcp_oauth_keyring(status) WHERE status = 'active';
    `);
    db = createNodeSqlDatabase(sqlite);
  });

  afterEach(() => sqlite.close());

  it("refuses to work without an active key", async () => {
    const keyring = new D1McpOAuthKeyring(db);

    await expect(keyring.active()).rejects.toThrow(McpOAuthKeyringError);
  });

  it("keeps the retired key readable after a rotation", async () => {
    const keyring = new D1McpOAuthKeyring(db);
    await keyring.rotate("key-1", keyMaterial(1), 1_000);

    const active = await keyring.active();
    expect(active.keyId).toBe("key-1");

    await keyring.rotate("key-2", keyMaterial(2), 2_000);

    const next = await keyring.active();
    expect(next.keyId).toBe("key-2");
    // The retired key stays available so the material it protected is still
    // readable until it is re-encrypted.
    const readable = await keyring.decryptable();
    expect(readable.map((key) => key.keyId)).toEqual(["key-2", "key-1"]);
  });

  it("refuses a key that is not 32 bytes", async () => {
    const keyring = new D1McpOAuthKeyring(db);

    await expect(keyring.rotate("key-1", btoa("short"), 1_000)).rejects.toThrow(
      McpOAuthKeyringError
    );
  });
});
