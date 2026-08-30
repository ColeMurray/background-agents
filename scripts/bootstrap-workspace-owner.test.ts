import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildBootstrapSql, parseArgs } from "./bootstrap-workspace-owner.ts";

const USER_ID = "11111111111111111111111111111111";
const OTHER_USER_ID = "22222222222222222222222222222222";

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      suspended_at INTEGER
    );
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE,
      is_system INTEGER NOT NULL
    );
    CREATE TABLE user_role_assignments (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      role_id TEXT NOT NULL REFERENCES roles(id),
      assigned_by TEXT,
      assigned_at INTEGER NOT NULL
    );
    CREATE TABLE authorization_audit_events (
      id TEXT PRIMARY KEY,
      occurred_at INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      principal_kind TEXT NOT NULL,
      actor_user_id_snapshot TEXT,
      actor_service_snapshot TEXT,
      actor_provider_snapshot TEXT,
      actor_provider_user_id_snapshot TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      target_user_id_snapshot TEXT,
      decision_outcome TEXT NOT NULL,
      operation_result TEXT,
      reason_code TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    INSERT INTO roles (id, key, is_system) VALUES
      ('role_builtin_owner', 'owner', 1),
      ('role_builtin_member', 'member', 1);
    INSERT INTO users (id, suspended_at) VALUES ('${USER_ID}', NULL);
    INSERT INTO user_role_assignments (user_id, role_id, assigned_by, assigned_at)
    VALUES ('${USER_ID}', 'role_builtin_member', NULL, 1);
  `);
  return database;
}

function sql(execute: boolean, auditId = "audit-id", now = 100): string {
  return buildBootstrapSql({ userId: USER_ID, execute, auditId, now });
}

function preflight(database: DatabaseSync): Record<string, unknown> {
  return { ...database.prepare(sql(false, "unused", 0)).get() };
}

function execute(database: DatabaseSync, auditId: string, now: number): void {
  database.exec(sql(true, auditId, now));
}

function insertSuccessfulHistory(
  database: DatabaseSync,
  targetUserId = OTHER_USER_ID,
  id = "audit-history"
): void {
  database
    .prepare(
      `INSERT INTO authorization_audit_events
        (id, occurred_at, request_id, policy_id, principal_kind,
         actor_service_snapshot, action, resource_type, target_user_id_snapshot,
         decision_outcome, operation_result, reason_code, metadata_json)
       VALUES (?, 1, 'operator-cli:history', 'workspace.owner_bootstrapped', 'service',
         'operator-cli', 'workspace.owner_bootstrapped', 'workspace', ?,
         'allowed', 'succeeded', 'operator_cli', '{}')`
    )
    .run(id, targetUserId);
}

describe("Owner bootstrap CLI arguments", () => {
  it("defaults to a remote dry run and accepts explicit execution", () => {
    assert.deepEqual(parseArgs(["--database", "open-inspect-prod", "--user", USER_ID]), {
      database: "open-inspect-prod",
      userId: USER_ID,
      execute: false,
    });
    assert.deepEqual(
      parseArgs(["--database", "open-inspect-dev", "--user", USER_ID, "--execute"]),
      {
        database: "open-inspect-dev",
        userId: USER_ID,
        execute: true,
      }
    );
  });

  it("rejects unknown, duplicate, missing, and non-canonical arguments", () => {
    assert.throws(() => parseArgs(["--database", "db", "--user", USER_ID, "--force"]), /Unknown/);
    assert.throws(
      () => parseArgs(["--database", "db", "--database", "other", "--user", USER_ID]),
      /Duplicate/
    );
    assert.throws(() => parseArgs(["--database", "--user", USER_ID]), /Missing value/);
    assert.throws(
      () => parseArgs(["--database", "db", "--user", "owner@example.com"]),
      /canonical/
    );
    assert.throws(
      () => parseArgs(["--database", "db", "--user", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA"]),
      /canonical/
    );
  });
});

describe("Owner bootstrap SQL", () => {
  it("reports ready only for an unsuspended target with one assignment and no Owner or history", () => {
    const database = createDatabase();

    assert.deepEqual(preflight(database), {
      report: "preflight",
      status: "ready",
      detail: "selected user can be bootstrapped",
      user_id: USER_ID,
      suspended_at: null,
      role_id: "role_builtin_member",
      successful_bootstrap_history: 0,
    });
    assert.equal(
      database.prepare("SELECT role_id FROM user_role_assignments").get()!.role_id,
      "role_builtin_member"
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
      0
    );
  });

  it("assigns Owner and writes exactly one redacted successful service audit", () => {
    const database = createDatabase();
    execute(database, "audit-'success", 100);

    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT role_id, assigned_by, assigned_at
             FROM user_role_assignments WHERE user_id = ?`
          )
          .get(USER_ID),
      },
      { role_id: "role_builtin_owner", assigned_by: null, assigned_at: 100 }
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT id, request_id, policy_id, principal_kind, actor_user_id_snapshot,
                    actor_service_snapshot, actor_provider_snapshot,
                    actor_provider_user_id_snapshot, action, resource_type, resource_id,
                    target_user_id_snapshot, decision_outcome, operation_result,
                    reason_code, metadata_json
             FROM authorization_audit_events`
          )
          .get(),
      },
      {
        id: "audit-'success",
        request_id: "operator-cli:audit-'success",
        policy_id: "workspace.owner_bootstrapped",
        principal_kind: "service",
        actor_user_id_snapshot: null,
        actor_service_snapshot: "operator-cli",
        actor_provider_snapshot: null,
        actor_provider_user_id_snapshot: null,
        action: "workspace.owner_bootstrapped",
        resource_type: "workspace",
        resource_id: null,
        target_user_id_snapshot: USER_ID,
        decision_outcome: "allowed",
        operation_result: "succeeded",
        reason_code: "operator_cli",
        metadata_json: "{}",
      }
    );
  });

  it("is an idempotent no-op for the current unsuspended Owner with global bootstrap history", () => {
    const database = createDatabase();
    execute(database, "audit-first", 100);
    execute(database, "audit-second", 200);

    assert.deepEqual(preflight(database), {
      report: "preflight",
      status: "no-op",
      detail: "selected user is the current unsuspended Owner with bootstrap history",
      user_id: USER_ID,
      suspended_at: null,
      role_id: "role_builtin_owner",
      successful_bootstrap_history: 1,
    });
    assert.equal(
      database.prepare("SELECT assigned_at FROM user_role_assignments").get()!.assigned_at,
      100
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
      1
    );
  });

  it("treats bootstrap history as immutable workspace-global provenance", () => {
    const database = createDatabase();
    database.exec(
      `UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = '${USER_ID}'`
    );
    insertSuccessfulHistory(database);

    assert.equal(preflight(database).status, "no-op");
  });

  it("refuses another unsuspended Owner without changing the selected user", () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO users (id, suspended_at) VALUES ('${OTHER_USER_ID}', NULL);
      INSERT INTO user_role_assignments (user_id, role_id, assigned_by, assigned_at)
      VALUES ('${OTHER_USER_ID}', 'role_builtin_owner', NULL, 1);
    `);

    assert.deepEqual(preflight(database), {
      report: "preflight",
      status: "refused",
      detail: "another unsuspended Owner already exists",
      user_id: USER_ID,
      suspended_at: null,
      role_id: "role_builtin_member",
      successful_bootstrap_history: 0,
    });
    assert.throws(() => execute(database, "audit-refused", 100), /integer overflow/);
    assert.equal(
      database.prepare("SELECT role_id FROM user_role_assignments WHERE user_id = ?").get(USER_ID)!
        .role_id,
      "role_builtin_member"
    );
  });

  it("requires the RBAC schema and an unsuspended target with exactly one assignment", () => {
    const missingSchema = new DatabaseSync(":memory:");
    assert.throws(() => execute(missingSchema, "audit-missing-schema", 100), /no such table/);

    const incompleteSchema = createDatabase();
    incompleteSchema.exec("ALTER TABLE authorization_audit_events DROP COLUMN metadata_json");
    assert.deepEqual(preflight(incompleteSchema), {
      report: "preflight",
      status: "refused",
      detail: "required RBAC schema is missing or incomplete",
      user_id: USER_ID,
      suspended_at: null,
      role_id: "role_builtin_member",
      successful_bootstrap_history: 0,
    });

    const suspended = createDatabase();
    suspended.exec(`UPDATE users SET suspended_at = 1 WHERE id = '${USER_ID}'`);
    assert.equal(preflight(suspended).detail, "target user is suspended");
    assert.throws(() => execute(suspended, "audit-suspended", 100), /integer overflow/);

    const missingAssignment = createDatabase();
    missingAssignment.exec(`DELETE FROM user_role_assignments WHERE user_id = '${USER_ID}'`);
    assert.equal(
      preflight(missingAssignment).detail,
      "target must have exactly one role assignment"
    );
    assert.throws(() => execute(missingAssignment, "audit-unassigned", 100), /integer overflow/);
  });

  it("refuses history without the current target Owner and Owner without history", () => {
    const historyWithoutOwner = createDatabase();
    insertSuccessfulHistory(historyWithoutOwner);
    assert.equal(
      preflight(historyWithoutOwner).detail,
      "successful bootstrap history exists without the target as current Owner"
    );
    assert.throws(() => execute(historyWithoutOwner, "audit-refused", 100), /integer overflow/);

    const ownerWithoutHistory = createDatabase();
    ownerWithoutHistory.exec(
      `UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = '${USER_ID}'`
    );
    assert.equal(
      preflight(ownerWithoutHistory).detail,
      "target is Owner without successful bootstrap history"
    );
    assert.throws(() => execute(ownerWithoutHistory, "audit-refused", 100), /integer overflow/);
  });

  it("uses only current RBAC schema and the generated audit ID as execution provenance", () => {
    const generated = sql(true, "audit-exact", 100);

    assert.doesNotMatch(
      generated,
      /workspace_bootstrap|authorization_version|access_status|mutation_id/
    );
    assert.match(generated, /SELECT 1 FROM authorization_audit_events WHERE id = 'audit-exact'/);
  });
});
