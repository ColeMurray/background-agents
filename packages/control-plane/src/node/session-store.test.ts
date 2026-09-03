import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  it("keeps the sessions directory and every database file private to the host user", () => {
    const store = open("session-1");
    const mode = (path: string): number => statSync(path).mode & 0o777;
    expect(mode(join(dataDir, "sessions"))).toBe(0o700);
    expect(mode(store.path)).toBe(0o600);
    expect(mode(`${store.path}-wal`)).toBe(0o600);
    store.close();

    // A directory or file that already exists with wider modes is narrowed.
    chmodSync(join(dataDir, "sessions"), 0o755);
    chmodSync(store.path, 0o644);
    open("session-1");
    expect(mode(join(dataDir, "sessions"))).toBe(0o700);
    expect(mode(store.path)).toBe(0o600);
  });

  it("waits for another connection's lock instead of failing the open", async () => {
    // A child process creates the file, takes the write lock, and holds it
    // long enough for this process to open the same session meanwhile.
    const holder = join(dataDir, "hold.mjs");
    writeFileSync(
      holder,
      `import { DatabaseSync } from "node:sqlite";
      import { mkdirSync } from "node:fs";
      mkdirSync(process.argv[2] + "/sessions", { recursive: true });
      const db = new DatabaseSync(process.argv[2] + "/sessions/session-1.db");
      db.exec("BEGIN IMMEDIATE; CREATE TABLE held (v TEXT);");
      process.stdout.write("locked\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      db.exec("COMMIT");
      db.close();`
    );
    const child = spawn(process.execPath, ["--no-warnings", holder, dataDir], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve) => child.stdout.on("data", () => resolve()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

    const store = open("session-1");
    expect(store.storage.sql.exec("SELECT v FROM held").toArray()).toEqual([]);
    expect(store.storage.sql.exec("PRAGMA journal_mode").one()).toEqual({ journal_mode: "wal" });
    expect(await exited).toBe(0);
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
