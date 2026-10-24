/**
 * Unit tests for the Pi Durable Object's tracked migration registry.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  PI_DO_OUTBOX_MIGRATION_ID,
  PI_DO_REPOSITORY_DIFF_OUTBOX_MIGRATION_ID,
  validateMigrationArtifacts,
} from "@open-inspect/shared/migration-reservations";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { PiProjectionOutbox } from "./projection-outbox";
import { RepositoryDiffOutbox } from "./repository-diff-outbox";
import { PI_DO_MIGRATIONS, applyPiDoMigrations, assertPiDoTables } from "./schema";

function database() {
  const db = new DatabaseSync(":memory:");
  return { db, sql: createNodeSqlStorage(db).sql };
}

describe("the Pi Durable Object's migration registry", () => {
  it("owns unique, reserved, increasing migration ids", () => {
    const ids = PI_DO_MIGRATIONS.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(() =>
      validateMigrationArtifacts(
        PI_DO_MIGRATIONS.map((migration) => ({
          store: "pi_do" as const,
          version: migration.id,
          name: migration.description,
          feature: migration.feature,
        }))
      )
    ).not.toThrow();
    expect(ids[0]).toBe(PI_DO_OUTBOX_MIGRATION_ID);
    expect(ids).toContain(PI_DO_REPOSITORY_DIFF_OUTBOX_MIGRATION_ID);
  });

  it("creates the outbox tables and records what it applied", () => {
    const { db, sql } = database();
    try {
      applyPiDoMigrations(sql);

      const tables = (
        sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(tables).toContain("oi_pi_projection_outbox");
      expect(tables).toContain("oi_pi_projection_finalization");
      expect(tables).toContain("oi_pi_repository_diff_outbox");

      const applied = (
        sql.exec("SELECT id FROM _schema_migrations ORDER BY id").toArray() as Array<{ id: number }>
      ).map((row) => row.id);
      expect(applied).toEqual(PI_DO_MIGRATIONS.map((migration) => migration.id));
    } finally {
      db.close();
    }
  });

  it("applies nothing twice", () => {
    const { db, sql } = database();
    try {
      applyPiDoMigrations(sql);
      const before = (
        sql.exec("SELECT id FROM _schema_migrations").toArray() as Array<{
          id: number;
        }>
      ).length;
      applyPiDoMigrations(sql);
      const after = (
        sql.exec("SELECT id FROM _schema_migrations").toArray() as Array<{
          id: number;
        }>
      ).length;
      expect(after).toBe(before);
    } finally {
      db.close();
    }
  });

  it("leaves an already migrated database's tables intact", () => {
    const { db, sql } = database();
    try {
      // A database written by the old runtime-created tables: the migration
      // finds them already present and keeps them.
      sql.exec(
        "CREATE TABLE IF NOT EXISTS oi_pi_projection_outbox (sequence INTEGER NOT NULL, operation_id TEXT NOT NULL, display_id TEXT NOT NULL, source_id TEXT, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER, failed_at INTEGER, failure TEXT, PRIMARY KEY(operation_id, sequence), UNIQUE(operation_id, source_id))"
      );
      applyPiDoMigrations(sql);
      assertPiDoTables(sql, "oi_pi_projection_outbox");
    } finally {
      db.close();
    }
  });

  it("refuses to assert a table the migrations did not create", () => {
    const { db, sql } = database();
    try {
      expect(() => assertPiDoTables(sql, "oi_pi_projection_outbox")).toThrow(
        /migrations did not run/
      );
      applyPiDoMigrations(sql);
      expect(() => assertPiDoTables(sql, "oi_pi_projection_outbox")).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("the outboxes read the migrated tables", () => {
  it("refuses to work against a database that did not migrate", async () => {
    const { db } = database();
    try {
      const outbox = new PiProjectionOutbox(new NodeSqliteDatabase(db), async () => undefined);
      await expect(outbox.pending("message-1")).rejects.toThrow(/migrations did not run/);
    } finally {
      db.close();
    }
  });

  it("refuses to work against a database that did not migrate", async () => {
    const { db } = database();
    try {
      const outbox = new RepositoryDiffOutbox(new NodeSqliteDatabase(db));
      await expect(outbox.state()).rejects.toThrow(/migrations did not run/);
    } finally {
      db.close();
    }
  });

  it("works against a migrated database", async () => {
    const { db, sql } = database();
    try {
      applyPiDoMigrations(sql);
      const database = new NodeSqliteDatabase(db);
      const outbox = new RepositoryDiffOutbox(database);
      expect((await outbox.state()).generation).toBe(0);
      const projection = new PiProjectionOutbox(database, async () => undefined);
      await expect(projection.pending("message-1")).resolves.toBe(0);
    } finally {
      db.close();
    }
  });
});
