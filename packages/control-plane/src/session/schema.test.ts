/**
 * Unit tests for schema migration tracking.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyMigrations, MIGRATIONS } from "./schema";
import type { SqlStorage, SqlResult } from "./repository";

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
    // All 24 IDs already applied
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
    // Migration 24 checks session columns — include base_branch so it skips the rename
    mock.setData("PRAGMA table_info(session)", [{ name: "base_branch" }]);
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
});
