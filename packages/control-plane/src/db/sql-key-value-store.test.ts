import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { SqlKeyValueStore } from "./sql-key-value-store";

let db: NodeSqlDatabase;
let nowMs: number;
let store: SqlKeyValueStore;

beforeEach(() => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE integration_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER
  )`);
  db = createNodeSqlDatabase(sqlite);
  nowMs = 1_800_000_000_000;
  store = new SqlKeyValueStore(db, () => nowMs);
});

afterEach(() => db.close());

describe("SqlKeyValueStore", () => {
  it("supports text and JSON values", async () => {
    await store.put("text", "value");
    await store.put("json", JSON.stringify({ enabled: true }));

    await expect(store.get("text")).resolves.toBe("value");
    await expect(store.get("json", "json")).resolves.toEqual({ enabled: true });
  });

  it("expires values and removes expired rows on the next write", async () => {
    await store.put("expired", "value", { expirationTtl: 1 });
    nowMs += 1_000;

    await expect(store.get("expired")).resolves.toBeNull();
    await store.put("live", "value");

    const row = await db
      .prepare("SELECT count(*) AS count FROM integration_kv")
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it("lists only live keys under the requested prefix", async () => {
    await store.put("slack:one", "1");
    await store.put("linear:one", "2");
    await store.put("slack:expired", "3", { expirationTtl: 1 });
    nowMs += 1_000;

    await expect(store.list({ prefix: "slack:" })).resolves.toEqual({
      keys: [{ name: "slack:one" }],
    });
  });
});
