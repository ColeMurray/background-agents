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
      access_status TEXT NOT NULL,
      authorization_version INTEGER NOT NULL,
      last_authorization_mutation_id TEXT,
      updated_at INTEGER NOT NULL
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
    CREATE TABLE workspace_bootstrap (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      claimed_at INTEGER NOT NULL,
      assignment_completed_at INTEGER
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
      authorization_version INTEGER,
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
    INSERT INTO users
      (id, access_status, authorization_version, last_authorization_mutation_id, updated_at)
    VALUES ('${USER_ID}', 'active', 7, NULL, 1);
    INSERT INTO user_role_assignments (user_id, role_id, assigned_by, assigned_at)
    VALUES ('${USER_ID}', 'role_builtin_member', NULL, 1);
  `);
  return database;
}

function execute(database: DatabaseSync, auditId: string, now: number): void {
  database.exec(buildBootstrapSql({ userId: USER_ID, execute: true, auditId, now }));
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
  it("keeps dry-run SQL read-only", () => {
    const database = createDatabase();
    database.exec(
      buildBootstrapSql({ userId: USER_ID, execute: false, auditId: "unused", now: 10 })
    );

    assert.deepEqual(
      { ...database.prepare("SELECT role_id FROM user_role_assignments").get() },
      {
        role_id: "role_builtin_member",
      }
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM workspace_bootstrap").get()!.count,
      0
    );
  });

  it("assigns Owner, increments version once, completes bootstrap, and writes a redacted audit", () => {
    const database = createDatabase();
    execute(database, "audit-'success", 100);

    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT u.access_status, u.authorization_version, a.role_id, a.assigned_by,
                  b.owner_user_id, b.assignment_completed_at
           FROM users u
           JOIN user_role_assignments a ON a.user_id = u.id
           JOIN workspace_bootstrap b ON b.owner_user_id = u.id
           WHERE u.id = ?`
          )
          .get(USER_ID),
      },
      {
        access_status: "active",
        authorization_version: 8,
        role_id: "role_builtin_owner",
        assigned_by: null,
        owner_user_id: USER_ID,
        assignment_completed_at: 100,
      }
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT principal_kind, actor_service_snapshot, authorization_version, action,
                  target_user_id_snapshot, reason_code, metadata_json
           FROM authorization_audit_events`
          )
          .get(),
      },
      {
        principal_kind: "service",
        actor_service_snapshot: "operator-cli",
        authorization_version: 8,
        action: "workspace.owner_bootstrapped",
        target_user_id_snapshot: USER_ID,
        reason_code: "operator_cli",
        metadata_json: "{}",
      }
    );
  });

  it("is an idempotent no-op for the selected completed active Owner", () => {
    const database = createDatabase();
    execute(database, "audit-first", 100);
    execute(database, "audit-second", 200);

    assert.equal(
      database.prepare("SELECT authorization_version FROM users").get()!.authorization_version,
      8
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
      1
    );
    assert.equal(
      database.prepare("SELECT assignment_completed_at FROM workspace_bootstrap").get()!
        .assignment_completed_at,
      100
    );
  });

  it("refuses another active Owner without changing the selected user", () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO users
        (id, access_status, authorization_version, last_authorization_mutation_id, updated_at)
      VALUES ('${OTHER_USER_ID}', 'active', 1, NULL, 1);
      INSERT INTO user_role_assignments (user_id, role_id, assigned_by, assigned_at)
      VALUES ('${OTHER_USER_ID}', 'role_builtin_owner', NULL, 1);
    `);

    assert.throws(() => execute(database, "audit-refused", 100), /integer overflow/);
    assert.equal(
      database.prepare("SELECT role_id FROM user_role_assignments WHERE user_id = ?").get(USER_ID)!
        .role_id,
      "role_builtin_member"
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
      0
    );
  });

  it("requires the RBAC schema and an active target with exactly one assignment", () => {
    const missingSchema = new DatabaseSync(":memory:");
    assert.throws(() => execute(missingSchema, "audit-missing-schema", 100), /no such table/);

    const incompleteSchema = createDatabase();
    incompleteSchema.exec("DROP TABLE authorization_audit_events");
    const preflight = incompleteSchema
      .prepare(buildBootstrapSql({ userId: USER_ID, execute: false, auditId: "unused", now: 100 }))
      .get();
    assert.equal(preflight!.status, "refused");
    assert.equal(preflight!.detail, "required RBAC schema is missing or incomplete");

    const suspended = createDatabase();
    suspended.exec(`UPDATE users SET access_status = 'suspended' WHERE id = '${USER_ID}'`);
    assert.throws(() => execute(suspended, "audit-suspended", 100), /integer overflow/);
    assert.equal(
      suspended.prepare("SELECT authorization_version FROM users").get()!.authorization_version,
      7
    );

    const missingAssignment = createDatabase();
    missingAssignment.exec(`DELETE FROM user_role_assignments WHERE user_id = '${USER_ID}'`);
    assert.throws(() => execute(missingAssignment, "audit-unassigned", 100), /integer overflow/);
    assert.equal(
      missingAssignment.prepare("SELECT COUNT(*) AS count FROM workspace_bootstrap").get()!.count,
      0
    );
  });

  it("refuses a completed bootstrap for another user", () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO users
        (id, access_status, authorization_version, last_authorization_mutation_id, updated_at)
      VALUES ('${OTHER_USER_ID}', 'suspended', 1, NULL, 1);
      INSERT INTO user_role_assignments (user_id, role_id, assigned_by, assigned_at)
      VALUES ('${OTHER_USER_ID}', 'role_builtin_owner', NULL, 1);
      INSERT INTO workspace_bootstrap
        (singleton, owner_user_id, claimed_at, assignment_completed_at)
      VALUES (1, '${OTHER_USER_ID}', 1, 1);
    `);

    assert.throws(() => execute(database, "audit-refused", 100), /integer overflow/);
    assert.equal(
      database.prepare("SELECT authorization_version FROM users WHERE id = ?").get(USER_ID)!
        .authorization_version,
      7
    );
  });
});
