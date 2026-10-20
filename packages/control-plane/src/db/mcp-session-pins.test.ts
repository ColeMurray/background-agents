import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { McpSessionPinConflictError, McpSessionPinStore } from "./mcp-session-pins";

describe("McpSessionPinStore", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let store: McpSessionPinStore;

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
    for (const migration of ["0091_mcp_oauth_foundation.sql", "0094_mcp_session_pins.sql"]) {
      sqlite.exec(
        readFileSync(
          fileURLToPath(
            new URL(`../../../../terraform/d1/migrations/${migration}`, import.meta.url)
          ),
          "utf8"
        )
      );
    }
    sqlite.exec(
      `INSERT INTO mcp_connections
         (id, owner_user_id, server_id, server_revision, server_name, endpoint_url,
          endpoint_host, catalog_snapshot_sha256, status, created_at, updated_at)
       VALUES ('mcpconn_1', 'owner-1', 'server-1', 3, 'Docs', 'https://mcp.example.com/mcp',
               'mcp.example.com', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
               'foundation_staged', 1000, 1000);
       INSERT INTO mcp_connections
         (id, owner_user_id, server_id, server_revision, server_name, endpoint_url,
          endpoint_host, catalog_snapshot_sha256, status, created_at, updated_at)
       VALUES ('mcpconn_2', 'other-1', 'server-1', 3, 'Docs', 'https://mcp.example.com/mcp',
               'mcp.example.com', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
               'foundation_staged', 1000, 1000);`
    );
    db = createNodeSqlDatabase(sqlite);
    store = new McpSessionPinStore(db);
  });

  afterEach(() => sqlite.close());

  it("grants a connection to a session and records the reviewed tools", async () => {
    const pin = await store.grant({
      ownerUserId: "owner-1",
      connectionId: "mcpconn_1",
      sessionId: "session-1",
      catalogSnapshotSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      toolNames: ["search"],
    });

    expect(pin).toMatchObject({
      sessionId: "session-1",
      connectionId: "mcpconn_1",
      ownerUserId: "owner-1",
      toolNames: ["search"],
      status: "active",
    });
    await expect(store.listForSession("session-1")).resolves.toHaveLength(1);
  });

  it("refuses a grant from anyone but the connection owner", async () => {
    await expect(
      store.grant({
        ownerUserId: "other-1",
        connectionId: "mcpconn_1",
        sessionId: "session-1",
        catalogSnapshotSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        toolNames: ["search"],
      })
    ).rejects.toThrow(/Only the MCP connection owner/);
    await expect(store.listForSession("session-1")).resolves.toHaveLength(0);
  });

  it("refuses a grant made against a catalog that has changed", async () => {
    await expect(
      store.grant({
        ownerUserId: "owner-1",
        connectionId: "mcpconn_1",
        sessionId: "session-1",
        catalogSnapshotSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        toolNames: ["search"],
      })
    ).rejects.toThrow(McpSessionPinConflictError);
  });

  it("refuses a second grant of the same connection to the same session", async () => {
    const input = {
      ownerUserId: "owner-1",
      connectionId: "mcpconn_1",
      sessionId: "session-1",
      catalogSnapshotSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      toolNames: ["search"],
    };
    await store.grant(input);

    await expect(store.grant(input)).rejects.toThrow(McpSessionPinConflictError);
  });

  it("revokes a grant for its owner only", async () => {
    const pin = await store.grant({
      ownerUserId: "owner-1",
      connectionId: "mcpconn_1",
      sessionId: "session-1",
      catalogSnapshotSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      toolNames: ["search"],
    });

    await expect(store.revoke(pin.id, "other-1")).resolves.toBe(false);
    await expect(store.revoke(pin.id, "owner-1")).resolves.toBe(true);
    await expect(store.listForSession("session-1")).resolves.toHaveLength(0);
  });

  it("revokes every grant of a connection at once", async () => {
    for (const sessionId of ["session-1", "session-2"]) {
      await store.grant({
        ownerUserId: "owner-1",
        connectionId: "mcpconn_1",
        sessionId,
        catalogSnapshotSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        toolNames: ["search"],
      });
    }

    await expect(store.revokeAllForConnection("mcpconn_1")).resolves.toBe(2);
    await expect(store.listForSession("session-1")).resolves.toHaveLength(0);
    await expect(store.listForSession("session-2")).resolves.toHaveLength(0);
  });

  it("never lists a grant of another session", async () => {
    await store.grant({
      ownerUserId: "owner-1",
      connectionId: "mcpconn_1",
      sessionId: "session-1",
      catalogSnapshotSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      toolNames: ["search"],
    });

    await expect(store.listForSession("session-2")).resolves.toHaveLength(0);
  });
});
