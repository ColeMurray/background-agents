import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import { AutomationExternalActionGrantStore } from "./automation-external-action-grants";

describe("AutomationExternalActionGrantStore", () => {
  let sqlite: DatabaseSync;
  let store: AutomationExternalActionGrantStore;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, suspended_at INTEGER);
      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      INSERT INTO users VALUES ('executor-1', NULL), ('executor-2', NULL), ('admin-1', NULL);
      INSERT INTO automations VALUES ('automation-1', 'executor-1', 1000, NULL);
    `);
    sqlite.exec(
      readFileSync(
        fileURLToPath(
          new URL("../../../../terraform/d1/migrations/0090_external_actions.sql", import.meta.url)
        ),
        "utf8"
      )
    );
    store = new AutomationExternalActionGrantStore(createNodeSqlDatabase(sqlite));
  });

  afterEach(() => sqlite.close());

  it("returns a grant only for the automation's current executor", async () => {
    await store.create({
      id: "grant-1",
      automationId: "automation-1",
      executorUserId: "executor-1",
      provider: "fake",
      action: "publish_comment",
      createdBy: "admin-1",
      createdAt: 2_000,
    });

    await expect(
      store.findActive("automation-1", "executor-1", "fake", "publish_comment")
    ).resolves.toMatchObject({ id: "grant-1", executorUserId: "executor-1" });
    await expect(
      store.findActive("automation-1", "executor-2", "fake", "publish_comment")
    ).resolves.toBeNull();
  });

  it("revokes unattended grants atomically when the executor changes", async () => {
    await store.create({
      id: "grant-1",
      automationId: "automation-1",
      executorUserId: "executor-1",
      provider: "fake",
      action: "publish_comment",
      createdBy: "admin-1",
      createdAt: 2_000,
    });

    sqlite
      .prepare("UPDATE automations SET user_id = ?, updated_at = ? WHERE id = ?")
      .run("executor-2", 3_000, "automation-1");

    await expect(
      store.findActive("automation-1", "executor-1", "fake", "publish_comment")
    ).resolves.toBeNull();
    expect(
      sqlite
        .prepare(
          "SELECT revoked_at, revoked_reason FROM automation_external_action_grants WHERE id = ?"
        )
        .get("grant-1")
    ).toEqual({ revoked_at: 3000, revoked_reason: "executor_changed" });
  });

  it("refuses to create a grant for a stale executor", async () => {
    await expect(
      store.create({
        id: "grant-stale",
        automationId: "automation-1",
        executorUserId: "executor-2",
        provider: "fake",
        action: "publish_comment",
        createdBy: "admin-1",
        createdAt: 2_000,
      })
    ).resolves.toBe(false);
  });

  it("stops authorizing a grant when the executor is suspended", async () => {
    await store.create({
      id: "grant-1",
      automationId: "automation-1",
      executorUserId: "executor-1",
      provider: "fake",
      action: "publish_comment",
      createdBy: "admin-1",
      createdAt: 2_000,
    });
    sqlite.prepare("UPDATE users SET suspended_at = 2500 WHERE id = 'executor-1'").run();

    await expect(
      store.findActive("automation-1", "executor-1", "fake", "publish_comment")
    ).resolves.toBeNull();
  });
});
