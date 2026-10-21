import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { McpConnectionStore } from "./mcp-connections";

const OWNER = "owner-1";
const OTHER = "other-1";
const CONNECTION = "mcpconn_1";
const CATALOG = "a".repeat(64);

describe("McpConnectionStore transport state", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let store: McpConnectionStore;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, suspended_at INTEGER);
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        url TEXT,
        env TEXT NOT NULL DEFAULT '{}',
        headers TEXT NOT NULL DEFAULT '{}',
        repo_scope TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('owner-1', NULL), ('other-1', NULL);
      INSERT INTO mcp_servers VALUES ('server-1', 3, 'Docs', 'remote', 'https://mcp.example.com/mcp', '{}', '{}', NULL, 1, 1000, 1000);
    `);
    sqlite.exec(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../terraform/d1/migrations/9002_mcp_oauth_foundation.sql",
            import.meta.url
          )
        ),
        "utf8"
      )
    );
    sqlite.exec(
      `INSERT INTO mcp_connections
         (id, owner_user_id, server_id, server_revision, server_name, endpoint_url,
          endpoint_host, catalog_snapshot_sha256, status, created_at, updated_at)
       VALUES ('mcpconn_1', 'owner-1', 'server-1', 3, 'Docs', 'https://mcp.example.com/mcp',
               'mcp.example.com', '${CATALOG}', 'foundation_staged', 1000, 1000);`
    );
    db = createNodeSqlDatabase(sqlite);
    store = new McpConnectionStore(db);
  });

  async function statusOf(id: string): Promise<string | undefined> {
    const row = await db
      .prepare("SELECT status FROM mcp_connections WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    return row?.status;
  }

  it("records the transport state the broker observed for the owner", async () => {
    await expect(store.setTransportStatus(CONNECTION, OWNER, "oauth_authorizing")).resolves.toBe(
      true
    );
    await expect(statusOf(CONNECTION)).resolves.toBe("oauth_authorizing");

    await expect(store.setTransportStatus(CONNECTION, OWNER, "oauth_ready")).resolves.toBe(true);
    await expect(statusOf(CONNECTION)).resolves.toBe("oauth_ready");
  });

  it("never lets one owner record a state on another owner's connection", async () => {
    await expect(store.setTransportStatus(CONNECTION, OTHER, "oauth_ready")).resolves.toBe(false);
    await expect(statusOf(CONNECTION)).resolves.toBe("foundation_staged");
  });

  it("never overwrites a revocation that is already in flight", async () => {
    await expect(store.markRevoking(CONNECTION, OWNER)).resolves.not.toBeNull();

    await expect(store.setTransportStatus(CONNECTION, OWNER, "oauth_ready")).resolves.toBe(false);
    await expect(statusOf(CONNECTION)).resolves.toBe("revoking");
  });
});
