import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildBootstrapSql, parseArgs, run } from "./bootstrap-workspace-owner.ts";

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
      role_id TEXT NOT NULL REFERENCES roles(id)
    );
    CREATE TABLE authorization_audit_events (
      id TEXT PRIMARY KEY,
      occurred_at INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      principal_kind TEXT NOT NULL,
      actor_user_id_snapshot TEXT,
      actor_service_snapshot TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      target_user_id_snapshot TEXT,
      reason_code TEXT NOT NULL,
      operation_result TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    INSERT INTO roles (id, key, is_system) VALUES
      ('role_builtin_owner', 'owner', 1),
      ('role_builtin_member', 'member', 1);
    INSERT INTO users (id, suspended_at) VALUES ('${USER_ID}', NULL);
    INSERT INTO user_role_assignments (user_id, role_id)
    VALUES ('${USER_ID}', 'role_builtin_member');
  `);
  return database;
}

function sql(auditId = "audit-id", now = 100) {
  return buildBootstrapSql({ userId: USER_ID, auditId, now });
}

function preflight(database: DatabaseSync): Record<string, unknown> {
  return { ...database.prepare(sql().preflight).get() };
}

function execute(database: DatabaseSync, auditId: string, now: number): void {
  database.exec(sql(auditId, now).execution.join("\n"));
}

// Model the result-bearing D1 query transaction with real SQLite statements.
// SQLite identifies statement boundaries; do not split SQL on literal semicolons.
function databaseRunner(database: DatabaseSync) {
  return (_database: string, operation: readonly string[]): string => {
    assert.equal(operation[0], "--command");
    database.exec("BEGIN");
    try {
      let remaining = operation[1];
      const results = [];
      while (remaining.trim()) {
        const statement = database.prepare(remaining);
        results.push({ success: true, results: statement.all() });
        remaining = remaining.slice(statement.sourceSQL.length);
      }
      database.exec("COMMIT");
      return JSON.stringify(results);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
}

function insertPriorAudit(
  database: DatabaseSync,
  targetUserId = OTHER_USER_ID,
  id = "audit-history"
): void {
  database
    .prepare(
      `INSERT INTO authorization_audit_events
        (id, occurred_at, request_id, principal_kind,
         actor_service_snapshot, action, resource_type, target_user_id_snapshot,
          reason_code, operation_result, metadata_json)
       VALUES (?, 1, 'operator-cli:history', 'service',
           'operator-cli', 'workspace.owner_bootstrapped', 'workspace', ?,
           'operator_cli', 'applied', '{"legacy":true}')`
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
  it("reports ready for an unsuspended target with one assignment and no Owner", () => {
    const database = createDatabase();

    assert.deepEqual(preflight(database), {
      report: "preflight",
      status: "ready",
      detail: "selected user can be bootstrapped",
      user_id: USER_ID,
      suspended_at: null,
      role_id: "role_builtin_member",
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
            `SELECT role_id
             FROM user_role_assignments WHERE user_id = ?`
          )
          .get(USER_ID),
      },
      { role_id: "role_builtin_owner" }
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
                    actor_service_snapshot, action, resource_type, resource_id,
                    target_user_id_snapshot, reason_code, operation_result, metadata_json
             FROM authorization_audit_events`
          )
          .get(),
      },
      {
        id: "audit-'success",
        occurred_at: 100,
        request_id: "operator-cli:audit-'success",
        principal_kind: "service",
        actor_user_id_snapshot: null,
        actor_service_snapshot: "operator-cli",
        action: "workspace.owner_bootstrapped",
        resource_type: "workspace",
        resource_id: null,
        target_user_id_snapshot: USER_ID,
        reason_code: "operator_cli",
        operation_result: "applied",
        metadata_json: JSON.stringify({
          before: { roleId: "role_builtin_member" },
          requested: { roleId: "role_builtin_owner" },
          after: { roleId: "role_builtin_owner" },
        }),
      }
    );
  });

  it("is an idempotent no-op for the current unsuspended Owner", () => {
    const database = createDatabase();
    execute(database, "audit-first", 100);
    execute(database, "audit-second", 200);

    assert.deepEqual(preflight(database), {
      report: "preflight",
      status: "no-op",
      detail: "selected user is already the current unsuspended Owner",
      user_id: USER_ID,
      suspended_at: null,
      role_id: "role_builtin_owner",
    });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
      1
    );
  });

  it("ignores prior bootstrap audit history when current Owner state is missing", () => {
    const database = createDatabase();
    insertPriorAudit(database);

    assert.equal(preflight(database).status, "ready");
    execute(database, "audit-current", 100);
    assert.equal(
      database.prepare("SELECT role_id FROM user_role_assignments").get()!.role_id,
      "role_builtin_owner"
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
      2
    );
  });

  it("cannot replay generated SQL after ownership conditions change", () => {
    const database = createDatabase();
    const generated = sql("audit-replay", 100).execution.join("\n");
    database.exec(generated);
    database.exec(`
      UPDATE user_role_assignments
      SET role_id = 'role_builtin_member'
      WHERE user_id = '${USER_ID}';
      INSERT INTO users (id, suspended_at) VALUES ('${OTHER_USER_ID}', NULL);
      INSERT INTO user_role_assignments (user_id, role_id)
      VALUES ('${OTHER_USER_ID}', 'role_builtin_owner');
    `);

    database.exec(generated);

    assert.equal(
      database.prepare("SELECT role_id FROM user_role_assignments WHERE user_id = ?").get(USER_ID)!
        .role_id,
      "role_builtin_member"
    );
  });

  it("refuses another unsuspended Owner without changing the selected user", () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO users (id, suspended_at) VALUES ('${OTHER_USER_ID}', NULL);
      INSERT INTO user_role_assignments (user_id, role_id)
      VALUES ('${OTHER_USER_ID}', 'role_builtin_owner');
    `);

    assert.deepEqual(preflight(database), {
      report: "preflight",
      status: "refused",
      detail: "another unsuspended Owner already exists",
      user_id: USER_ID,
      suspended_at: null,
      role_id: "role_builtin_member",
    });
    execute(database, "audit-refused", 100);
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
    incompleteSchema.exec("ALTER TABLE authorization_audit_events DROP COLUMN reason_code");
    assert.deepEqual(preflight(incompleteSchema), {
      report: "preflight",
      status: "refused",
      detail: "required RBAC schema is missing or incomplete",
      user_id: USER_ID,
      suspended_at: null,
      role_id: "role_builtin_member",
    });

    const suspended = createDatabase();
    suspended.exec(`UPDATE users SET suspended_at = 1 WHERE id = '${USER_ID}'`);
    assert.equal(preflight(suspended).detail, "target user is suspended");
    execute(suspended, "audit-suspended", 100);

    const missingAssignment = createDatabase();
    missingAssignment.exec(`DELETE FROM user_role_assignments WHERE user_id = '${USER_ID}'`);
    assert.equal(
      preflight(missingAssignment).detail,
      "target must have exactly one role assignment"
    );
    execute(missingAssignment, "audit-unassigned", 100);
  });

  it("treats a current target Owner as a no-op without requiring audit history", () => {
    const database = createDatabase();
    database.exec(
      `UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = '${USER_ID}'`
    );
    assert.equal(preflight(database).status, "no-op");
    execute(database, "audit-no-op", 100);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
      0
    );
  });

  it("uses only current RBAC schema and the generated audit ID as execution provenance", () => {
    const generated = sql("audit-exact", 100).execution.join("\n");

    assert.doesNotMatch(
      generated,
      /workspace_bootstrap|authorization_version|access_status|mutation_id|policy_id|decision_outcome|actor_provider|assigned_by|assigned_at/
    );
    assert.match(generated, /operation_result/);
    assert.match(generated, /metadata_json/);
    assert.match(generated, /WHERE id = 'audit-exact'/);
  });
});

describe("Owner bootstrap orchestration", () => {
  it("returns the exact audit proof in one mutation batch after preflight", async () => {
    const database = createDatabase();
    const runner = databaseRunner(database);
    const results: unknown[] = [];
    await run(
      { database: "workspace", userId: USER_ID, execute: true },
      {
        randomUUID: () => "audit-';exact",
        now: () => 123,
        runWrangler: (name, operation) => {
          const output = runner(name, operation);
          results.push(JSON.parse(output));
          return output;
        },
      }
    );
    assert.equal(results.length, 2);
    assert.deepEqual(results[1], [
      { success: true, results: [] },
      { success: true, results: [] },
      {
        success: true,
        results: [
          {
            report: "postcondition",
            status: "executed",
            user_id: USER_ID,
            suspended_at: null,
            role_id: "role_builtin_owner",
            audit_written: 1,
          },
        ],
      },
    ]);
    assert.equal(
      database.prepare("SELECT id FROM authorization_audit_events").get()!.id,
      "audit-';exact"
    );
  });

  it("rejects a concurrent winner between preflight and the mutation batch", async () => {
    const database = createDatabase();
    const runner = databaseRunner(database);
    let calls = 0;
    await assert.rejects(
      run(
        { database: "workspace", userId: USER_ID, execute: true },
        {
          randomUUID: () => "audit-loser",
          now: () => 123,
          runWrangler: (name, operation) => {
            if (++calls === 2) execute(database, "audit-winner", 122);
            return runner(name, operation);
          },
        }
      ),
      /ownership may have changed concurrently/
    );
    assert.equal(
      database.prepare("SELECT id FROM authorization_audit_events").get()!.id,
      "audit-winner"
    );
    assert.equal(calls, 2);
  });

  for (const failure of ["assignment", "postcondition"]) {
    it(`rolls back the entire batch when ${failure} SQL fails`, async () => {
      const database = createDatabase();
      if (failure === "assignment") {
        database.exec(`CREATE TRIGGER refuse_owner BEFORE UPDATE ON user_role_assignments
          BEGIN SELECT RAISE(ABORT, 'assignment failed'); END`);
      }
      const runner = databaseRunner(database);
      let calls = 0;
      await assert.rejects(
        run(
          { database: "workspace", userId: USER_ID, execute: true },
          {
            runWrangler: (name, operation) => {
              calls += 1;
              // Fail the actual final SELECT after both writes have executed.
              const command =
                calls === 2 && failure === "postcondition"
                  ? operation[1].replace(
                      "SELECT 'postcondition' AS report",
                      "SELECT missing_function() AS report"
                    )
                  : operation[1];
              return runner(name, [operation[0], command]);
            },
          }
        ),
        /assignment failed|no such function/
      );
      assert.equal(calls, 2);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
        0
      );
      assert.equal(
        database.prepare("SELECT role_id FROM user_role_assignments").get()!.role_id,
        "role_builtin_member"
      );
    });
  }

  it("does not add a read that can fail after the batch has returned its proof", async () => {
    const database = createDatabase();
    const runner = databaseRunner(database);
    let calls = 0;
    await run(
      { database: "workspace", userId: USER_ID, execute: true },
      {
        runWrangler: (name, operation) => {
          if (++calls > 2) throw new Error("unexpected post-commit read");
          const output = runner(name, operation);
          if (calls === 2) database.exec("UPDATE users SET suspended_at = 1");
          return output;
        },
      }
    );
    assert.equal(calls, 2);
  });

  it("does not automatically retry an uncertain batch response", async () => {
    const database = createDatabase();
    const runner = databaseRunner(database);
    let calls = 0;
    await assert.rejects(
      run(
        { database: "workspace", userId: USER_ID, execute: true },
        {
          runWrangler: (name, operation) => {
            const output = runner(name, operation);
            if (++calls === 2) throw new Error("batch response lost");
            return output;
          },
        }
      ),
      /batch response lost/
    );
    assert.equal(calls, 2);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
      1
    );
  });

  const empty = { success: true, results: [] };
  const proof = { report: "postcondition", status: "executed", audit_written: 1 };
  for (const [label, response] of [
    ["non-array", {}],
    ["import aggregate", [{ success: true, results: [{ "Total queries executed": 3 }] }]],
    ["missing statement result", [empty, empty]],
    ["extra statement result", [empty, empty, empty, empty]],
    [
      "failed statement",
      [{ success: false, results: [] }, empty, { success: true, results: [proof] }],
    ],
    ["malformed rows", [empty, empty, { success: true, results: [null] }]],
    ["missing proof", [empty, empty, empty]],
    ["misplaced proof", [{ success: true, results: [proof] }, empty, empty]],
    ["ambiguous proof", [empty, empty, { success: true, results: [proof, proof] }]],
    ["missing audit", [empty, empty, { success: true, results: [{ ...proof, audit_written: 0 }] }]],
  ]) {
    it(`rejects a batch response with ${label}`, async () => {
      const database = createDatabase();
      const runner = databaseRunner(database);
      let calls = 0;
      await assert.rejects(
        run(
          { database: "workspace", userId: USER_ID, execute: true },
          {
            runWrangler: (name, operation) =>
              ++calls === 1 ? runner(name, operation) : JSON.stringify(response),
          }
        ),
        /malformed|results for|no valid|did not prove/
      );
      assert.equal(calls, 2);
    });
  }

  it("never executes after an unknown preflight status", async () => {
    let calls = 0;
    await assert.rejects(
      run(
        { database: "workspace", userId: USER_ID, execute: true },
        {
          runWrangler: () => {
            calls += 1;
            return JSON.stringify([
              { success: true, results: [{ report: "preflight", status: "unknown" }] },
            ]);
          },
        }
      ),
      /no valid Owner bootstrap preflight/
    );
    assert.equal(calls, 1);
  });

  for (const execute of [false, true]) {
    it(
      execute ? "does not mutate for a current Owner" : "does not mutate during a dry run",
      async () => {
        const database = createDatabase();
        if (execute)
          database.exec("UPDATE user_role_assignments SET role_id = 'role_builtin_owner'");
        const runner = databaseRunner(database);
        let calls = 0;
        await run(
          { database: "workspace", userId: USER_ID, execute },
          {
            runWrangler: (name, operation) => {
              calls += 1;
              return runner(name, operation);
            },
          }
        );
        assert.equal(calls, 1);
        assert.equal(
          database.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").get()!.count,
          0
        );
      }
    );
  }
});

describe("Owner bootstrap verification evidence", () => {
  for (const [label, change] of [
    ["missing audit", "DELETE FROM authorization_audit_events"],
    ["wrong audit ID", "UPDATE authorization_audit_events SET id = 'other-audit'"],
    ["wrong audit time", "UPDATE authorization_audit_events SET occurred_at = 999"],
    ["wrong request", "UPDATE authorization_audit_events SET request_id = 'other-request'"],
    [
      "wrong target",
      `UPDATE authorization_audit_events SET target_user_id_snapshot = '${OTHER_USER_ID}'`,
    ],
    ["wrong action", "UPDATE authorization_audit_events SET action = 'other-action'"],
    ["wrong result", "UPDATE authorization_audit_events SET operation_result = 'refused'"],
    ["wrong role metadata", "UPDATE authorization_audit_events SET metadata_json = '{}'"],
    ["demoted Owner", "UPDATE user_role_assignments SET role_id = 'role_builtin_member'"],
    ["suspended Owner", "UPDATE users SET suspended_at = 1"],
    ["missing assignment", "DELETE FROM user_role_assignments"],
    [
      "another Owner",
      `INSERT INTO users VALUES ('${OTHER_USER_ID}', NULL);
      INSERT INTO user_role_assignments VALUES ('${OTHER_USER_ID}', 'role_builtin_owner')`,
    ],
  ]) {
    it(`rejects verification with ${label}`, () => {
      const database = createDatabase();
      execute(database, "audit-exact", 123);
      database.exec(change);
      const report = database.prepare(sql("audit-exact", 123).execution[2]).get();
      assert.notEqual(report?.status, "executed");
    });
  }
});
