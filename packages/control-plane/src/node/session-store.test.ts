import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionStore, type NodeSessionStore } from "./session-store";

describe("openSessionStore", () => {
  let dataDir: string;
  const opened: NodeSessionStore[] = [];
  const open = (sessionId: string): NodeSessionStore => {
    const store = openSessionStore({ dataDir, sessionId });
    opened.push(store);
    return store;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "session-store-"));
  });

  afterEach(() => {
    for (const store of opened.splice(0)) {
      try {
        store.close();
      } catch {
        // already closed by the test
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates <dataDir>/sessions/<id>.db in WAL mode with a busy timeout and the schema applied", () => {
    const store = open("session-1");
    expect(store.path).toBe(join(dataDir, "sessions", "session-1.db"));
    expect(existsSync(store.path)).toBe(true);
    expect(store.storage.sql.exec("PRAGMA journal_mode").one()).toEqual({ journal_mode: "wal" });
    expect(store.storage.sql.exec("PRAGMA busy_timeout").one()).toEqual({ timeout: 5000 });
    expect(store.storage.sql.exec("PRAGMA foreign_keys").one()).toEqual({ foreign_keys: 1 });
    expect(
      store.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'session'").one()
    ).toEqual({ n: 1 });
  });

  it("persists rows across close and reopen of the same session", () => {
    const first = open("session-1");
    first.storage.sql.exec("CREATE TABLE marker (v TEXT)");
    first.storage.transactionSync(() => first.storage.sql.exec("INSERT INTO marker VALUES ('x')"));
    first.close();

    const second = open("session-1");
    expect(second.storage.sql.exec("SELECT v FROM marker").one()).toEqual({ v: "x" });
    expect(
      open("session-2")
        .storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'marker'")
        .toArray()
    ).toEqual([]);
  });

  it("rejects a session id that is not a single file name", () => {
    for (const id of ["", "..", "../escape", "a/b", ".hidden", "nul\0"]) {
      expect(() => openSessionStore({ dataDir, sessionId: id })).toThrow(
        "cannot name a session file"
      );
    }
    expect(existsSync(join(dataDir, "escape.db"))).toBe(false);
  });

  it("makes every statement throw after close", () => {
    const store = open("session-1");
    store.close();
    expect(() => store.storage.sql.exec("SELECT 1")).toThrow("not open");
  });
});
