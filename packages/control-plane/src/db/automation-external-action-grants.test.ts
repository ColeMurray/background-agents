import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import { AutomationExternalActionGrantStore } from "./automation-external-action-grants";
import { AutomationExecutorReassignmentStore } from "./automation-executor-reassignment";
import type { NodeSqlDatabase } from "../node/sqlite-database";

describe("AutomationExternalActionGrantStore", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let store: AutomationExternalActionGrantStore;
  let reassignments: AutomationExecutorReassignmentStore;

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
      CREATE TABLE authorization_audit_events (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('executor-1', NULL), ('executor-2', NULL), ('admin-1', NULL);
      INSERT INTO automations VALUES ('automation-1', 'executor-1', 1000, NULL);
    `);
    sqlite.exec(
      readFileSync(
        fileURLToPath(
          new URL("../../../../terraform/d1/migrations/9001_external_actions.sql", import.meta.url)
        ),
        "utf8"
      )
    );
    db = createNodeSqlDatabase(sqlite);
    store = new AutomationExternalActionGrantStore(db);
    reassignments = new AutomationExecutorReassignmentStore(db);
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

  describe("application-level reassignment without the compatibility trigger", () => {
    beforeEach(() => {
      sqlite.exec("DROP TRIGGER revoke_external_action_grants_on_executor_change");
    });

    it("revokes every active grant that no longer matches a guarded executor reassignment", async () => {
      insertGrant("grant-old-1", "executor-1", "publish_comment");
      insertGrant("grant-old-2", "executor-1", "close_issue");
      insertGrant("grant-history", "executor-1", "merge_pull_request", 1_500, "operator_revoked");

      await db.batch(
        reassignments.bindGuardedReassignment({
          executorUpdate: db
            .prepare(
              "UPDATE automations SET user_id = ?, updated_at = ? WHERE id = ? AND user_id = ?"
            )
            .bind("executor-2", 3_000, "automation-1", "executor-1"),
          audit: {
            id: "audit-1",
            statement: db
              .prepare("INSERT INTO authorization_audit_events (id) SELECT ? WHERE changes() = 1")
              .bind("audit-1"),
          },
          automationId: "automation-1",
          revokedAt: 3_000,
        })
      );

      expect(grants()).toEqual([
        {
          id: "grant-history",
          executor_user_id: "executor-1",
          revoked_at: 1_500,
          revoked_reason: "operator_revoked",
        },
        {
          id: "grant-old-1",
          executor_user_id: "executor-1",
          revoked_at: 3_000,
          revoked_reason: "executor_changed",
        },
        {
          id: "grant-old-2",
          executor_user_id: "executor-1",
          revoked_at: 3_000,
          revoked_reason: "executor_changed",
        },
      ]);
    });

    it("does not revoke grants when the executor compare-and-set loses", async () => {
      insertGrant("grant-current", "executor-1", "publish_comment");
      insertGrant("grant-unrelated-mismatch", "executor-2", "close_issue");

      const results = await db.batch(
        reassignments.bindGuardedReassignment({
          executorUpdate: db
            .prepare("UPDATE automations SET user_id = ? WHERE id = ? AND user_id = ?")
            .bind("executor-2", "automation-1", "stale-executor"),
          audit: {
            id: "audit-cas",
            statement: db
              .prepare("INSERT INTO authorization_audit_events (id) SELECT ? WHERE changes() = 1")
              .bind("audit-cas"),
          },
          automationId: "automation-1",
          revokedAt: 3_000,
        })
      );

      expect(results[0]?.meta.changes).toBe(0);
      expect(
        sqlite.prepare("SELECT user_id FROM automations WHERE id = 'automation-1'").get()
      ).toEqual({ user_id: "executor-1" });
      expect(grants().every((grant) => grant.revoked_at === null)).toBe(true);
    });

    it("rolls back the executor, audit, and revocations when the batch fails", async () => {
      insertGrant("grant-1", "executor-1", "publish_comment");
      const statements = reassignments.bindGuardedReassignment({
        executorUpdate: db
          .prepare(
            "UPDATE automations SET user_id = ?, updated_at = ? WHERE id = ? AND user_id = ?"
          )
          .bind("executor-2", 3_000, "automation-1", "executor-1"),
        audit: {
          id: "audit-failure",
          statement: db
            .prepare("INSERT INTO authorization_audit_events (id) SELECT ? WHERE changes() = 1")
            .bind("audit-failure"),
        },
        automationId: "automation-1",
        revokedAt: 3_000,
      });

      await expect(
        db.batch([...statements, db.prepare("INSERT INTO users (id) VALUES ('executor-1')")])
      ).rejects.toThrow();

      expect(
        sqlite.prepare("SELECT user_id FROM automations WHERE id = 'automation-1'").get()
      ).toEqual({ user_id: "executor-1" });
      expect(grants()[0]).toMatchObject({ revoked_at: null, revoked_reason: null });
      expect(sqlite.prepare("SELECT id FROM authorization_audit_events").all()).toEqual([]);
    });

    it("keeps the invariant through a bulk executor reassignment and reference repoint", async () => {
      sqlite.exec("INSERT INTO automations VALUES ('automation-2', 'executor-1', 1000, NULL)");
      insertGrant("grant-1", "executor-1", "publish_comment", null, null, "automation-1");
      insertGrant("grant-2", "executor-1", "close_issue", null, null, "automation-2");
      insertGrant(
        "grant-history",
        "executor-1",
        "merge_pull_request",
        1_500,
        "operator_revoked",
        "automation-2"
      );

      await db.batch([
        ...reassignments.bindBulkReassignment({
          executorUpdate: db
            .prepare("UPDATE automations SET user_id = ? WHERE user_id = ? RETURNING id")
            .bind("executor-2", "executor-1"),
          automationId: null,
          previousExecutorUserId: "executor-1",
          nextExecutorUserId: "executor-2",
          revokedAt: 4_000,
        }),
        db
          .prepare(
            "UPDATE automation_external_action_grants SET executor_user_id = ? WHERE executor_user_id = ?"
          )
          .bind("executor-2", "executor-1"),
      ]);

      expect(
        sqlite.prepare("SELECT DISTINCT user_id FROM automations ORDER BY user_id").all()
      ).toEqual([{ user_id: "executor-2" }]);
      expect(grants()).toEqual([
        {
          id: "grant-1",
          executor_user_id: "executor-2",
          revoked_at: 4_000,
          revoked_reason: "executor_changed",
        },
        {
          id: "grant-2",
          executor_user_id: "executor-2",
          revoked_at: 4_000,
          revoked_reason: "executor_changed",
        },
        {
          id: "grant-history",
          executor_user_id: "executor-2",
          revoked_at: 1_500,
          revoked_reason: "operator_revoked",
        },
      ]);
    });
  });

  describe("parent-binary rollback compatibility with the migration trigger", () => {
    it("keeps a parent-style bare executor update safe during rollback", () => {
      insertGrant("grant-parent-update", "executor-1", "publish_comment");

      sqlite
        .prepare("UPDATE automations SET user_id = ?, updated_at = ? WHERE id = ?")
        .run("executor-2", 5_000, "automation-1");

      expect(grants()).toEqual([
        {
          id: "grant-parent-update",
          executor_user_id: "executor-1",
          revoked_at: 5_000,
          revoked_reason: "executor_changed",
        },
      ]);
    });

    it("keeps parent-style user-merge SQL safe during rollback", async () => {
      sqlite.exec("INSERT INTO automations VALUES ('automation-2', 'executor-1', 6000, NULL)");
      insertGrant(
        "grant-parent-merge",
        "executor-1",
        "publish_comment",
        null,
        null,
        "automation-2"
      );
      insertGrant(
        "grant-parent-history",
        "executor-1",
        "close_issue",
        1_500,
        "operator_revoked",
        "automation-2"
      );

      await db.batch([
        db
          .prepare("UPDATE automations SET user_id = ? WHERE user_id = ? RETURNING id")
          .bind("executor-2", "executor-1"),
        db
          .prepare(
            "UPDATE automation_external_action_grants SET executor_user_id = ? WHERE executor_user_id = ?"
          )
          .bind("executor-2", "executor-1"),
      ]);

      expect(grants()).toEqual([
        {
          id: "grant-parent-history",
          executor_user_id: "executor-2",
          revoked_at: 1_500,
          revoked_reason: "operator_revoked",
        },
        {
          id: "grant-parent-merge",
          executor_user_id: "executor-2",
          revoked_at: 6_000,
          revoked_reason: "executor_changed",
        },
      ]);
    });
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

  function insertGrant(
    id: string,
    executorUserId: string,
    action: string,
    revokedAt: number | null = null,
    revokedReason: string | null = null,
    automationId = "automation-1"
  ): void {
    sqlite
      .prepare(
        `INSERT INTO automation_external_action_grants
          (id, automation_id, executor_user_id, provider, action, created_by, created_at,
           revoked_at, revoked_reason)
         VALUES (?, ?, ?, 'fake', ?, 'admin-1', 2000, ?, ?)`
      )
      .run(id, automationId, executorUserId, action, revokedAt, revokedReason);
  }

  function grants() {
    return sqlite
      .prepare(
        `SELECT id, executor_user_id, revoked_at, revoked_reason
         FROM automation_external_action_grants ORDER BY id`
      )
      .all();
  }
});
