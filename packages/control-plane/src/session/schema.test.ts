/**
 * Unit tests for schema migration tracking.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyMigrations, initSchema, MIGRATIONS, SCHEMA_SQL } from "./schema";
import type { SqlResult, SqlStorage } from "./sql-storage";
import { createNodeSqlStorage } from "../node/sqlite-storage";

/**
 * Create a mock SqlStorage that tracks calls and supports per-query data.
 */
function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const queryData: Map<string, unknown[]> = new Map();

  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      const data = queryData.get(query) ?? [];
      return {
        toArray: () => data,
        one: () => null,
      };
    },
  };

  return {
    sql,
    calls,
    setData(query: string, data: unknown[]) {
      queryData.set(query, data);
    },
    reset() {
      calls.length = 0;
      queryData.clear();
    },
  };
}

function createDatabaseSql(db: DatabaseSync): SqlStorage {
  return createNodeSqlStorage(db).sql;
}

function expectClientRequestIdIndex(db: DatabaseSync): void {
  expect(db.prepare("PRAGMA index_list(messages)").all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "idx_messages_client_request_id", unique: 1 }),
    ])
  );
  expect(db.prepare("PRAGMA index_info(idx_messages_client_request_id)").all()).toEqual([
    expect.objectContaining({ name: "client_request_id" }),
  ]);
}

describe("applyMigrations", () => {
  let mock: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mock = createMockSql();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });

  it("runs all migrations on a fresh DO", () => {
    // No applied IDs → SELECT returns empty
    applyMigrations(mock.sql);

    const createTable = mock.calls.find((c) =>
      c.query.includes("CREATE TABLE IF NOT EXISTS _schema_migrations")
    );
    expect(createTable).toBeDefined();

    const selectCall = mock.calls.find((c) => c.query === "SELECT id FROM _schema_migrations");
    expect(selectCall).toBeDefined();

    // Each migration produces an exec call + an INSERT
    const inserts = mock.calls.filter((c) =>
      c.query.includes("INSERT OR IGNORE INTO _schema_migrations")
    );
    expect(inserts).toHaveLength(MIGRATIONS.length);

    // Verify all IDs are recorded
    const recordedIds = inserts.map((c) => c.params[0]);
    expect(recordedIds).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("skips all migrations when fully migrated", () => {
    // Every migration ID is already applied.
    const appliedRows = MIGRATIONS.map((m) => ({ id: m.id }));
    mock.setData("SELECT id FROM _schema_migrations", appliedRows);

    applyMigrations(mock.sql);

    // Should only have CREATE TABLE + SELECT, no migration execs or inserts
    const inserts = mock.calls.filter((c) =>
      c.query.includes("INSERT OR IGNORE INTO _schema_migrations")
    );
    expect(inserts).toHaveLength(0);

    const alterCalls = mock.calls.filter((c) => c.query.includes("ALTER TABLE"));
    expect(alterCalls).toHaveLength(0);
  });

  it("runs only unapplied migrations when partially migrated", () => {
    // IDs 1-10 already applied
    const appliedRows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    mock.setData("SELECT id FROM _schema_migrations", appliedRows);

    applyMigrations(mock.sql);

    const inserts = mock.calls.filter((c) =>
      c.query.includes("INSERT OR IGNORE INTO _schema_migrations")
    );
    // Migrations 11 through MIGRATIONS.length
    const unappliedCount = MIGRATIONS.length - 10;
    expect(inserts).toHaveLength(unappliedCount);

    const recordedIds = inserts.map((c) => c.params[0]);
    const expectedIds = MIGRATIONS.slice(10).map((m) => m.id);
    expect(recordedIds).toEqual(expectedIds);
  });

  it("validates PRAGMA rows in the earliest column-aware migration", () => {
    const migration = MIGRATIONS.find((entry) => entry.id === 7);
    if (!migration || typeof migration.run !== "function") {
      throw new Error("Expected migration 7 to be a function");
    }
    const run = migration.run;
    mock.setData("PRAGMA table_info(participants)", [{ name: 123 }]);

    expect(() => run(mock.sql)).toThrow("Invalid SQLite column metadata at row 0");
  });

  it("does not record a migration when PRAGMA metadata is malformed", () => {
    mock.setData(
      "SELECT id FROM _schema_migrations",
      MIGRATIONS.filter(({ id }) => id < 23).map(({ id }) => ({ id }))
    );
    mock.setData("PRAGMA table_info(session)", [{ name: "id" }, null]);

    expect(() => applyMigrations(mock.sql)).toThrow("Invalid SQLite column metadata at row 1");

    expect(
      mock.calls.some(
        ({ query, params }) =>
          query.includes("INSERT OR IGNORE INTO _schema_migrations") && params[0] === 23
      )
    ).toBe(false);
  });

  it("rethrows non-duplicate-column errors from string migrations", () => {
    // Make the exec throw a non-duplicate-column error for ALTER statements
    const originalExec = mock.sql.exec.bind(mock.sql);
    mock.sql.exec = (query: string, ...params: unknown[]): SqlResult => {
      if (query.includes("ALTER TABLE")) {
        throw new Error("disk I/O error");
      }
      return originalExec(query, ...params);
    };

    expect(() => applyMigrations(mock.sql)).toThrow("disk I/O error");
  });

  it("swallows duplicate column errors from string migrations", () => {
    // Seed PRAGMA data so function-based migrations (7, 20, 24) skip their ALTER TABLE calls.
    // This isolates the test to only exercise string migration error handling via runMigration().
    mock.setData("PRAGMA table_info(participants)", [
      { name: "scm_refresh_token_encrypted" },
      { name: "scm_user_id" },
      { name: "scm_login" },
      { name: "scm_email" },
      { name: "scm_name" },
      { name: "scm_access_token_encrypted" },
      { name: "scm_token_expires_at" },
    ]);
    // Migration 24 checks session columns.
    mock.setData("PRAGMA table_info(session)", [
      { name: "repo_owner", notnull: 0 },
      { name: "repo_name", notnull: 0 },
      { name: "base_branch", notnull: 0 },
    ]);
    const originalExec = mock.sql.exec.bind(mock.sql);
    mock.sql.exec = (query: string, ...params: unknown[]): SqlResult => {
      if (query.includes("ALTER TABLE")) {
        throw new Error("duplicate column name: session_name");
      }
      return originalExec(query, ...params);
    };

    // Should not throw — duplicate column errors are expected
    expect(() => applyMigrations(mock.sql)).not.toThrow();

    // All migrations should still be recorded
    const inserts = mock.calls.filter((c) =>
      c.query.includes("INSERT OR IGNORE INTO _schema_migrations")
    );
    expect(inserts).toHaveLength(MIGRATIONS.length);
  });

  it("is idempotent — calling twice produces no duplicate rows", () => {
    applyMigrations(mock.sql);

    // Now simulate a second call where all IDs are applied
    mock.reset();
    const appliedRows = MIGRATIONS.map((m) => ({ id: m.id }));
    mock.setData("SELECT id FROM _schema_migrations", appliedRows);

    applyMigrations(mock.sql);

    const inserts = mock.calls.filter((c) =>
      c.query.includes("INSERT OR IGNORE INTO _schema_migrations")
    );
    expect(inserts).toHaveLength(0);
  });

  it("executes function-type migrations directly", () => {
    // Migration 13 is a function (CREATE TABLE ws_client_mapping)
    applyMigrations(mock.sql);

    // The function migration should have created the ws_client_mapping table
    const wsTableCreate = mock.calls.find((c) =>
      c.query.includes("CREATE TABLE IF NOT EXISTS ws_client_mapping")
    );
    expect(wsTableCreate).toBeDefined();
  });

  it("records applied_at timestamp", () => {
    applyMigrations(mock.sql);

    const inserts = mock.calls.filter((c) =>
      c.query.includes("INSERT OR IGNORE INTO _schema_migrations")
    );
    // Second param should be the timestamp
    for (const insert of inserts) {
      expect(insert.params[1]).toBe(1000);
    }
  });

  it("does not execute transaction-control statements in migrations", () => {
    applyMigrations(mock.sql);

    const transactionControlStatements = mock.calls.filter((c) =>
      /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(c.query.trim())
    );
    expect(transactionControlStatements).toEqual([]);
  });

  it("creates session_repositories for both fresh DOs and migrated DOs", () => {
    // Fresh DOs get the table from SCHEMA_SQL; existing DOs via migration 31.
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS session_repositories");

    const migration = MIGRATIONS.find((m) => m.id === 31);
    expect(migration).toBeDefined();
    expect(migration?.run).toContain("CREATE TABLE IF NOT EXISTS session_repositories");
  });

  it("adds WebSocket authorization lease state for fresh and migrated DOs", () => {
    expect(SCHEMA_SQL).toContain("authorization_expires_at INTEGER NOT NULL");
    expect(SCHEMA_SQL).not.toContain("authorization_version");

    const migration = MIGRATIONS.find((entry) => entry.id === 46);
    expect(typeof migration?.run).toBe("function");
    const run = migration!.run as (sql: SqlStorage) => void;
    run(mock.sql);
    expect(
      mock.calls.filter(({ query }) => query.includes("ALTER TABLE")).map(({ query }) => query)
    ).toEqual([
      expect.stringContaining(
        "ws_client_mapping ADD COLUMN authorization_expires_at INTEGER NOT NULL DEFAULT 0"
      ),
    ]);
  });

  it("adds sandbox.active_socket_id for fresh and migrated DOs", () => {
    expect(SCHEMA_SQL).toContain("active_socket_id TEXT");

    const migration = MIGRATIONS.find((entry) => entry.id === 48);
    expect(migration?.run).toBe("ALTER TABLE sandbox ADD COLUMN active_socket_id TEXT");
  });

  it("keeps repository context consistent at the session table boundary", () => {
    expect(SCHEMA_SQL).toContain("(repo_owner IS NULL) = (repo_name IS NULL)");
    expect(SCHEMA_SQL).toContain("repo_owner IS NOT NULL");
    expect(SCHEMA_SQL).toContain("repo_id IS NULL AND base_branch IS NULL");
  });

  it("adds artifacts.updated_at for both fresh DOs and migrated DOs", () => {
    // Fresh DOs get the column NOT NULL from SCHEMA_SQL; existing DOs get a
    // nullable ADD COLUMN (SQLite restriction) plus a backfill via migration 34.
    const artifactsTable = SCHEMA_SQL.split("CREATE TABLE IF NOT EXISTS artifacts")[1]?.split(
      ");"
    )[0];
    expect(artifactsTable).toContain("updated_at INTEGER NOT NULL");

    const migration = MIGRATIONS.find((m) => m.id === 34);
    expect(migration).toBeDefined();
    expect(typeof migration?.run).toBe("function");

    (migration!.run as (sql: SqlStorage) => void)(mock.sql);

    const alter = mock.calls.find((c) =>
      c.query.includes("ALTER TABLE artifacts ADD COLUMN updated_at INTEGER")
    );
    expect(alter).toBeDefined();
    const backfill = mock.calls.find(
      (c) =>
        c.query.includes("UPDATE artifacts SET updated_at = created_at") &&
        c.query.includes("updated_at IS NULL")
    );
    expect(backfill).toBeDefined();
  });

  it("adds VNC session and sandbox fields for fresh and migrated DOs", () => {
    expect(SCHEMA_SQL).toContain("vnc_enabled INTEGER NOT NULL DEFAULT 0");
    expect(SCHEMA_SQL).toContain("vnc_url TEXT");
    expect(SCHEMA_SQL).toContain("vnc_password TEXT");

    const migration = MIGRATIONS.find((migration) => migration.id === 39);
    expect(typeof migration?.run).toBe("function");

    const db = new DatabaseSync(":memory:");
    const sql = createDatabaseSql(db);

    try {
      db.exec(
        "CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE sandbox (id TEXT PRIMARY KEY)"
      );
      const run = migration!.run as (sql: SqlStorage) => void;
      run(sql);
      expect(() => run(sql)).not.toThrow();

      expect(db.prepare("PRAGMA table_info(sandbox)").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "vnc_url", type: "TEXT", notnull: 0 }),
          expect.objectContaining({ name: "vnc_password", type: "TEXT", notnull: 0 }),
        ])
      );
      expect(db.prepare("PRAGMA table_info(session)").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "vnc_enabled",
            type: "INTEGER",
            notnull: 1,
            dflt_value: "0",
          }),
        ])
      );
    } finally {
      db.close();
    }
  });

  it("creates the final attachments schema in its single unshipped migration", () => {
    const migration = MIGRATIONS.find((entry) => entry.id === 35);
    expect(migration?.run).toContain("CREATE TABLE IF NOT EXISTS attachments");
    expect(migration?.run).toContain("cleanup_claimed_at INTEGER");
    expect(migration?.run).not.toContain("kind TEXT");
  });

  it("creates one latest-only session diff row for fresh and migrated sessions", () => {
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS session_diff");
    expect(SCHEMA_SQL).toContain("singleton INTEGER PRIMARY KEY CHECK (singleton = 1)");
    expect(SCHEMA_SQL).toContain("bundle_json TEXT");
    expect(SCHEMA_SQL).not.toContain("diff_objects");
    expect(SCHEMA_SQL).not.toContain("diff_capture_triggers");

    const migration = MIGRATIONS.find((item) => item.id === 36);
    expect(migration).toBeDefined();
    expect(migration?.run).toContain("CREATE TABLE IF NOT EXISTS session_diff");
  });

  it("persists pending and in-flight alarm state for fresh and migrated sessions", () => {
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS session_alarm_state");
    expect(SCHEMA_SQL).toContain("singleton INTEGER PRIMARY KEY CHECK (singleton = 1)");
    expect(SCHEMA_SQL).toContain("pending_deadline INTEGER");
    expect(SCHEMA_SQL).toContain("in_flight_deadline INTEGER");
    expect(SCHEMA_SQL).toContain("cancelled INTEGER NOT NULL DEFAULT 0");

    const migration = MIGRATIONS.find((item) => item.id === 43);
    expect(migration?.run).toContain("CREATE TABLE IF NOT EXISTS session_alarm_state");
  });

  it("adds prompt idempotency columns and index for fresh and migrated sessions", () => {
    const messagesTable = SCHEMA_SQL.split("CREATE TABLE IF NOT EXISTS messages")[1]?.split(
      ");"
    )[0];
    expect(messagesTable).toContain("client_request_id TEXT");
    expect(messagesTable).toContain("request_fingerprint TEXT");

    const migration = MIGRATIONS.find((entry) => entry.id === 40);
    expect(typeof migration?.run).toBe("function");
    const db = new DatabaseSync(":memory:");
    const sql = createDatabaseSql(db);
    try {
      db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY)");
      const run = migration!.run as (sql: SqlStorage) => void;
      run(sql);
      expect(() => run(sql)).not.toThrow();
      expect(db.prepare("PRAGMA table_info(messages)").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "client_request_id", type: "TEXT" }),
          expect.objectContaining({ name: "request_fingerprint", type: "TEXT" }),
        ])
      );
      expectClientRequestIdIndex(db);
    } finally {
      db.close();
    }
  });

  it("initializes a legacy messages table before creating indexes for new columns", () => {
    expect(SCHEMA_SQL).not.toMatch(/\bCREATE (?:UNIQUE )?INDEX\b/);

    const db = new DatabaseSync(":memory:");
    const sql = createDatabaseSql(db);
    try {
      db.exec(`CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        attachments TEXT,
        callback_context TEXT,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      )`);
      db.exec(
        "CREATE TABLE _schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
      );
      const recordMigration = db.prepare(
        "INSERT INTO _schema_migrations (id, applied_at) VALUES (?, 0)"
      );
      for (const migration of MIGRATIONS.filter(({ id }) => id < 40)) {
        recordMigration.run(migration.id);
      }

      expect(() => initSchema(sql)).not.toThrow();
      expect(db.prepare("PRAGMA table_info(messages)").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "client_request_id", type: "TEXT" }),
          expect.objectContaining({ name: "request_fingerprint", type: "TEXT" }),
          expect.objectContaining({ name: "stop_confirmation_deadline", type: "INTEGER" }),
        ])
      );
      expect(
        db
          .prepare("PRAGMA index_list(messages)")
          .all()
          .map((row) => row.name)
      ).toEqual(
        expect.arrayContaining([
          "idx_messages_status",
          "idx_messages_author",
          "idx_messages_client_request_id",
          "idx_messages_one_processing",
        ])
      );
      expectClientRequestIdIndex(db);
    } finally {
      db.close();
    }
  });

  it("adds a dedicated nullable stop confirmation deadline for fresh and migrated sessions", () => {
    const messagesTable = SCHEMA_SQL.split("CREATE TABLE IF NOT EXISTS messages")[1]?.split(
      ");"
    )[0];
    expect(messagesTable).toContain("stop_confirmation_deadline INTEGER");
    expect(MIGRATIONS.find((entry) => entry.id === 41)?.run).toContain(
      "ADD COLUMN stop_confirmation_deadline INTEGER"
    );
  });

  it("adds Autofix admission metadata and indexes for fresh and migrated sessions", () => {
    const messagesTable = SCHEMA_SQL.split("CREATE TABLE IF NOT EXISTS messages")[1]?.split(
      ");"
    )[0];
    expect(messagesTable).toContain("autofix_feedback_key TEXT");
    expect(messagesTable).toContain("autofix_pr_key TEXT");
    expect(messagesTable).toContain("origin_context TEXT");

    const migration = MIGRATIONS.find((entry) => entry.id === 45);
    expect(typeof migration?.run).toBe("function");
    const db = new DatabaseSync(":memory:");
    const sql = createDatabaseSql(db);
    try {
      db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
      const run = migration!.run as (sql: SqlStorage) => void;
      run(sql);
      expect(() => run(sql)).not.toThrow();
      expect(db.prepare("PRAGMA table_info(messages)").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "autofix_feedback_key", type: "TEXT" }),
          expect.objectContaining({ name: "autofix_pr_key", type: "TEXT" }),
          expect.objectContaining({ name: "origin_context", type: "TEXT" }),
        ])
      );
      expect(
        db
          .prepare("PRAGMA index_list(messages)")
          .all()
          .map((row) => row.name)
      ).toEqual(
        expect.arrayContaining(["idx_messages_autofix_feedback", "idx_messages_autofix_pr_created"])
      );
    } finally {
      db.close();
    }
  });

  it("allows only one processing message per session", () => {
    const migration = MIGRATIONS.find((entry) => entry.id === 42);
    expect(typeof migration?.run).toBe("function");

    const db = new DatabaseSync(":memory:");
    const sql = createDatabaseSql(db);
    try {
      db.exec(`CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER
      )`);
      db.exec(`CREATE TABLE events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        message_id TEXT
      )`);
      db.prepare(
        "INSERT INTO messages (id, status, created_at, started_at) VALUES (?, ?, ?, ?)"
      ).run("first", "processing", 100, 120);
      db.prepare(
        "INSERT INTO messages (id, status, created_at, started_at) VALUES (?, ?, ?, ?)"
      ).run("second", "processing", 110, 130);
      db.prepare(
        "INSERT INTO messages (id, status, created_at, started_at) VALUES (?, ?, ?, ?)"
      ).run("unrelated", "pending", 90, null);
      db.prepare("INSERT INTO events (id, type, message_id) VALUES (?, ?, ?)").run(
        "user_message:first",
        "user_message",
        "first"
      );
      db.prepare("INSERT INTO events (id, type, message_id) VALUES (?, ?, ?)").run(
        "user_message:second",
        "user_message",
        "second"
      );
      db.prepare("INSERT INTO events (id, type, message_id) VALUES (?, ?, ?)").run(
        "user_message:unrelated",
        "user_message",
        "unrelated"
      );

      const run = migration!.run as (sql: SqlStorage) => void;
      expect(() => run(sql)).not.toThrow();
      expect(() => run(sql)).not.toThrow();

      expect(db.prepare("SELECT id, status, started_at FROM messages ORDER BY id").all()).toEqual([
        { id: "first", status: "processing", started_at: 120 },
        { id: "second", status: "pending", started_at: null },
        { id: "unrelated", status: "pending", started_at: null },
      ]);
      expect(db.prepare("SELECT id FROM events ORDER BY id").all()).toEqual([
        { id: "user_message:first" },
        { id: "user_message:unrelated" },
      ]);
      expect(() =>
        db
          .prepare("INSERT INTO messages (id, status, created_at, started_at) VALUES (?, ?, ?, ?)")
          .run("third", "processing", 140, 150)
      ).toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO messages (id, status, created_at, started_at) VALUES (?, ?, ?, ?)")
          .run("queued", "pending", 160, null)
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
