import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { buildMaintenanceSql, parseArgs, run } from "./admission-policy-maintenance.ts";
import { runSql } from "./operator-sql.ts";
import { parseStoredAdmissionPolicy } from "../packages/shared/src/admission-settings.ts";

const RULES = {
  allowedGitHubUsers: ["alice"],
  allowedEmails: ["o'hara@example.com"],
  allowedEmailDomains: ["example.org"],
  allowedGitHubOrganizations: ["example-team"],
};

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "admission-maintenance-"));
  const path = join(directory, "workspace.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE authorization_audit_events (
    id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, request_id TEXT NOT NULL,
    principal_kind TEXT NOT NULL, actor_user_id_snapshot TEXT, actor_service_snapshot TEXT,
    action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
    target_user_id_snapshot TEXT, reason_code TEXT NOT NULL,
    operation_result TEXT NOT NULL CHECK (operation_result IN ('applied', 'no_op', 'denied', 'rejected')),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)
      AND json_type(metadata_json, '$.before') = 'object'
      AND json_type(metadata_json, '$.requested') = 'object'
      AND json_type(metadata_json, '$.after') = 'object')
  );`);
  database.exec(
    readFileSync(
      new URL("../terraform/d1/migrations/0093_workspace_admission_policy.sql", import.meta.url),
      "utf8"
    )
  );
  database
    .prepare(
      "UPDATE workspace_admission_policy SET rules_json = ?, revision = 7, updated_at = 10, updated_by_user_id_snapshot = 'last-editor'"
    )
    .run(JSON.stringify(RULES));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path, database };
}

function policy(database: DatabaseSync) {
  return { ...database.prepare("SELECT * FROM workspace_admission_policy").get() };
}

function audits(database: DatabaseSync) {
  return database.prepare("SELECT * FROM authorization_audit_events ORDER BY occurred_at").all();
}

describe("admission policy maintenance arguments", () => {
  it("requires an explicit backend and defaults changes to dry run", () => {
    assert.deepEqual(parseArgs(["status", "--database", "production"]), {
      action: "status",
      database: "production",
      execute: false,
    });
    assert.deepEqual(
      parseArgs(["freeze", "--sqlite", "workspace.sqlite", "--expected-revision", "0"]),
      {
        action: "freeze",
        sqlite: "workspace.sqlite",
        expectedRevision: 0,
        execute: false,
      }
    );
    assert.equal(
      parseArgs(["unfreeze", "--database", "production", "--expected-revision", "7", "--execute"])
        .execute,
      true
    );
  });

  for (const args of [
    [],
    ["export"],
    ["status"],
    ["status", "--database", "db", "--sqlite", "local.sqlite"],
    ["status", "--sqlite", ":memory:"],
    ["status", "--sqlite", "file:db.sqlite"],
    ["status", "--database", "db", "--execute"],
    ["status", "--database", "db", "--expected-revision", "0"],
    ["status", "--database", "db", "--local"],
    ["status", "--database", "db", "--database", "other"],
    ["status", "--database"],
    ["freeze", "--database", "db"],
    ["unfreeze", "--database", "db", "--execute"],
    ...["-1", "1.5", "1e2", "01", "9007199254740992", ""].map((revision) => [
      "unfreeze",
      "--database",
      "db",
      "--expected-revision",
      revision,
    ]),
    ["freeze", "--database", "db", "--expected-revision", "1", "--expected-revision", "2"],
    ["freeze", "--database", "db", "--expected-revision", "1", "--execute", "--execute"],
  ]) {
    it(`rejects invalid arguments ${JSON.stringify(args)}`, () => {
      assert.throws(() => parseArgs(args));
    });
  }
});

describe("admission policy maintenance on SQLite", () => {
  it("exports only authoritative managed rules and revision while frozen", async (t) => {
    const { path, database } = fixture(t);
    const before = policy(database);
    const snapshot = await run({ sqlite: path, action: "status", execute: false });
    assert.deepEqual(snapshot, {
      action: "status",
      status: "status",
      dryRun: false,
      schemaVersion: 1,
      revision: 7,
      writesFrozen: true,
      managed: RULES,
      updatedAt: 10,
      updatedByUserId: "last-editor",
    });
    assert.equal("deployment" in snapshot, false);
    assert.equal("effective" in snapshot, false);
    assert.deepEqual(policy(database), before);
    assert.equal(audits(database).length, 0);
  });

  it("dry-runs without changing policy or audit", async (t) => {
    const { path, database } = fixture(t);
    const before = policy(database);
    const report = await run({
      sqlite: path,
      action: "unfreeze",
      expectedRevision: 7,
      execute: false,
    });
    assert.equal(report.status, "ready");
    assert.equal(report.dryRun, true);
    assert.equal(report.writesFrozen, true);
    assert.deepEqual(policy(database), before);
    assert.equal(audits(database).length, 0);
  });

  it("unfreezes and freezes with revision increments, service audits, and unchanged rules", async (t) => {
    const { path, database } = fixture(t);
    const originalRules = policy(database).rules_json;
    for (const [index, action] of (["unfreeze", "freeze"] as const).entries()) {
      const report = await run(
        { sqlite: path, action, expectedRevision: 7 + index, execute: true },
        {
          randomUUID: () => `audit-';${action}`,
          now: () => 100 + index,
        }
      );
      assert.equal(report.status, "executed");
      assert.equal(report.revision, 8 + index);
      assert.equal(report.writesFrozen, action === "freeze");
      assert.deepEqual(report.managed, RULES);
      assert.equal(policy(database).rules_json, originalRules);
      assert.equal(policy(database).updated_by_user_id_snapshot, null);
      const audit = audits(database)[index];
      assert.equal(audit.id, `audit-';${action}`);
      assert.equal(audit.principal_kind, "service");
      assert.equal(audit.actor_user_id_snapshot, null);
      assert.equal(audit.actor_service_snapshot, "operator-cli");
      assert.equal(audit.action, "workspace.admission_policy_maintenance");
      assert.equal(audit.operation_result, "applied");
      assert.deepEqual(JSON.parse(String(audit.metadata_json)), {
        before: { revision: 7 + index, writesFrozen: index === 0 ? 1 : 0 },
        requested: { expectedRevision: 7 + index, writesFrozen: index },
        after: { revision: 8 + index, writesFrozen: index },
      });
    }
  });

  it("audits an explicitly executed no-op without advancing revision or changing metadata", async (t) => {
    const { path, database } = fixture(t);
    const before = policy(database);
    const report = await run({
      sqlite: path,
      action: "freeze",
      expectedRevision: 7,
      execute: true,
    });
    assert.equal(report.status, "no-op");
    assert.deepEqual(policy(database), before);
    assert.equal(audits(database)[0].operation_result, "no_op");
  });

  it("uses canonical distinct-rule limits without rewriting raw stored JSON", async (t) => {
    const { path, database } = fixture(t);
    const rules = {
      ...RULES,
      allowedGitHubUsers: Array(60).fill(" Alice "),
      allowedGitHubOrganizations: Array(12).fill(" Example-Team "),
    };
    const rulesJson = JSON.stringify(rules, null, 2);
    database.prepare("UPDATE workspace_admission_policy SET rules_json = ?").run(rulesJson);
    const report = await run({
      sqlite: path,
      action: "unfreeze",
      expectedRevision: 7,
      execute: true,
    });
    assert.equal(report.status, "executed");
    assert.deepEqual(report.managed, rules);
    assert.equal(policy(database).rules_json, rulesJson);
  });

  for (const assignment of [
    "updated_at = -1",
    "updated_at = 1.5",
    "updated_at = 'broken'",
    "updated_by_user_id_snapshot = ''",
  ]) {
    it(`refuses invalid persisted metadata before unfreezing: ${assignment}`, async (t) => {
      const { path, database } = fixture(t);
      database.exec(`UPDATE workspace_admission_policy SET ${assignment}`);
      const before = policy(database);
      await assert.rejects(run({ sqlite: path, action: "status", execute: false }), /refused/);
      await assert.rejects(
        run({ sqlite: path, action: "unfreeze", expectedRevision: 7, execute: true }),
        /refused/
      );
      assert.deepEqual(policy(database), before);
      assert.equal(audits(database).length, 0);
    });
  }

  for (const action of ["freeze", "unfreeze"] as const) {
    for (const execute of [false, true]) {
      it(`rejects stale ${action} even for an already-matching state (execute=${execute})`, async (t) => {
        const { path, database } = fixture(t);
        const before = policy(database);
        await assert.rejects(run({ sqlite: path, action, expectedRevision: 6, execute }), /stale/);
        assert.deepEqual(policy(database), before);
        assert.equal(audits(database).length, 0);
      });
    }
  }

  it("rejects a reviewed freeze after an API rule edit advances revision", async (t) => {
    const { path, database } = fixture(t);
    database.exec("UPDATE workspace_admission_policy SET writes_frozen = 0");
    await run({ sqlite: path, action: "freeze", expectedRevision: 7, execute: false });
    const changedRules = JSON.stringify({ ...RULES, allowedGitHubUsers: ["bob"] });
    database
      .prepare("UPDATE workspace_admission_policy SET revision = revision + 1, rules_json = ?")
      .run(changedRules);
    await assert.rejects(
      run({ sqlite: path, action: "freeze", expectedRevision: 7, execute: true }),
      /stale/
    );
    assert.equal(policy(database).writes_frozen, 0);
    assert.equal(policy(database).rules_json, changedRules);
    assert.equal(audits(database).length, 0);
  });

  for (const [label, trigger] of [
    [
      "audit failure",
      "BEFORE INSERT ON authorization_audit_events BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
    ],
    [
      "policy failure",
      "BEFORE UPDATE ON workspace_admission_policy BEGIN SELECT RAISE(ABORT, 'policy failed'); END",
    ],
    [
      "ignored update",
      "BEFORE UPDATE ON workspace_admission_policy BEGIN SELECT RAISE(IGNORE); END",
    ],
  ]) {
    it(`rolls back both policy and audit on ${label}`, async (t) => {
      const { path, database } = fixture(t);
      database.exec(`CREATE TRIGGER reject_write ${trigger}`);
      const before = policy(database);
      await assert.rejects(
        run({ sqlite: path, action: "unfreeze", expectedRevision: 7, execute: true })
      );
      assert.deepEqual(policy(database), before);
      assert.equal(audits(database).length, 0);
    });
  }

  for (const rules of [
    "not JSON",
    "null",
    "{}",
    "[]",
    JSON.stringify({ ...RULES, unknown: [] }),
    JSON.stringify({ ...RULES, allowedEmails: [42] }),
    JSON.stringify({ ...RULES, allowedEmails: ["not-an-email"] }),
    JSON.stringify({ ...RULES, allowedEmails: ["valid@example.com\n"] }),
    JSON.stringify({ ...RULES, allowedEmailDomains: ["*.example.com"] }),
    JSON.stringify({ ...RULES, allowedGitHubUsers: ["@alice"] }),
    JSON.stringify({ ...RULES, allowedGitHubOrganizations: ["https://github.com/example"] }),
    JSON.stringify({
      ...RULES,
      allowedGitHubUsers: Array.from({ length: 51 }, (_, i) => `user${i}`),
    }),
    JSON.stringify({
      ...RULES,
      allowedGitHubOrganizations: Array.from({ length: 11 }, (_, i) => `org${i}`),
    }),
  ]) {
    it(`refuses malformed or oversized policy ${rules.slice(0, 60)}`, async (t) => {
      const { path, database } = fixture(t);
      database.prepare("UPDATE workspace_admission_policy SET rules_json = ?").run(rules);
      const before = policy(database);
      await assert.rejects(run({ sqlite: path, action: "status", execute: false }));
      await assert.rejects(
        run({ sqlite: path, action: "unfreeze", expectedRevision: 7, execute: false })
      );
      await assert.rejects(
        run({ sqlite: path, action: "unfreeze", expectedRevision: 7, execute: true })
      );
      assert.deepEqual(policy(database), before);
      assert.equal(audits(database).length, 0);
    });
  }

  it("fails closed on unsupported schema, missing singleton, or missing database", async (t) => {
    const { path, database, directory } = fixture(t);
    database.exec(
      "PRAGMA ignore_check_constraints = ON; UPDATE workspace_admission_policy SET schema_version = 2;"
    );
    await assert.rejects(
      run({ sqlite: path, action: "unfreeze", expectedRevision: 7, execute: true }),
      /refused/
    );
    assert.equal(policy(database).writes_frozen, 1);
    assert.equal(audits(database).length, 0);
    database.exec("DELETE FROM workspace_admission_policy");
    await assert.rejects(run({ sqlite: path, action: "status", execute: false }), /singleton/);
    await assert.rejects(
      run({ sqlite: path, action: "freeze", expectedRevision: 7, execute: true }),
      /singleton/
    );
    assert.equal(audits(database).length, 0);
    const missing = join(directory, "missing.sqlite");
    await assert.rejects(
      run({ sqlite: missing, action: "freeze", expectedRevision: 7, execute: true }),
      /ENOENT/
    );
    assert.equal(existsSync(missing), false);
  });

  it("refuses revision overflow but permits a matching no-op", async (t) => {
    const { path, database } = fixture(t);
    database
      .prepare("UPDATE workspace_admission_policy SET revision = ?")
      .run(Number.MAX_SAFE_INTEGER);
    await assert.rejects(
      run({
        sqlite: path,
        action: "unfreeze",
        expectedRevision: Number.MAX_SAFE_INTEGER,
        execute: true,
      }),
      /refused/
    );
    assert.equal(audits(database).length, 0);
    const result = await run({
      sqlite: path,
      action: "freeze",
      expectedRevision: Number.MAX_SAFE_INTEGER,
      execute: true,
    });
    assert.equal(result.status, "no-op");
    assert.equal(result.revision, Number.MAX_SAFE_INTEGER);
  });
});

describe("admission policy remote transaction protocol", () => {
  it("validates before freezing and exports the mutation snapshot, never a later read", async (t) => {
    const { path, database } = fixture(t);
    database.exec("UPDATE workspace_admission_policy SET writes_frozen = 0");
    const sql = buildMaintenanceSql({
      action: "freeze",
      expectedRevision: 7,
      auditId: "remote-audit",
      now: 100,
      before: parseStoredAdmissionPolicy(policy(database)),
    });
    let calls = 0;
    const report = await run(
      { database: "production", action: "freeze", expectedRevision: 7, execute: true },
      {
        randomUUID: () => "remote-audit",
        now: () => 100,
        runWrangler: (name, operation) => {
          calls++;
          assert.equal(name, "production");
          if (calls === 1) return runSql({ sqlite: path }, [sql.preflight], false);
          assert.deepEqual(operation, ["--command", sql.execution.join("\n")]);
          const output = runSql({ sqlite: path }, sql.execution, true);
          // Another operator acts after commit. The export must still be the freeze transaction's snapshot.
          database.exec(
            "UPDATE workspace_admission_policy SET writes_frozen = 0, revision = revision + 1"
          );
          return output;
        },
      }
    );
    assert.equal(calls, 2);
    assert.equal(report.revision, 8);
    assert.equal(report.writesFrozen, true);
    assert.deepEqual(report.managed, RULES);
    assert.equal(policy(database).revision, 9);
  });

  it("rolls back writes when the final snapshot query fails", (t) => {
    const { path, database } = fixture(t);
    const before = policy(database);
    const sql = buildMaintenanceSql({
      action: "unfreeze",
      expectedRevision: 7,
      auditId: "fail",
      now: 100,
      before: parseStoredAdmissionPolicy(policy(database)),
    });
    assert.throws(
      () =>
        runSql(
          { sqlite: path },
          [...sql.execution.slice(0, -1), "SELECT missing_function()"],
          true
        ),
      /no such function/
    );
    assert.deepEqual(policy(database), before);
    assert.equal(audits(database).length, 0);
  });

  it("never retries an uncertain response after the transaction commits", async (t) => {
    const { path, database } = fixture(t);
    const sql = buildMaintenanceSql({
      action: "unfreeze",
      expectedRevision: 7,
      auditId: "lost",
      now: 100,
      before: parseStoredAdmissionPolicy(policy(database)),
    });
    let calls = 0;
    await assert.rejects(
      run(
        { database: "production", action: "unfreeze", expectedRevision: 7, execute: true },
        {
          randomUUID: () => "lost",
          now: () => 100,
          runWrangler: () => {
            calls++;
            if (calls === 1) return runSql({ sqlite: path }, [sql.preflight], false);
            runSql({ sqlite: path }, sql.execution, true);
            throw new Error("response lost");
          },
        }
      ),
      /response lost/
    );
    assert.equal(calls, 2);
    assert.equal(policy(database).revision, 8);
    assert.equal(audits(database).length, 1);
  });

  it("refuses an invalid restore between validation and the write, even at the same revision", async (t) => {
    const { path, database } = fixture(t);
    const input = { action: "unfreeze" as const, expectedRevision: 7, auditId: "race", now: 100 };
    const sql = buildMaintenanceSql({
      ...input,
      before: parseStoredAdmissionPolicy(policy(database)),
    });
    const invalidRules = JSON.stringify({ ...RULES, allowedEmails: ["not-an-email"] });
    let calls = 0;
    await assert.rejects(
      run(
        { database: "production", action: "unfreeze", expectedRevision: 7, execute: true },
        {
          randomUUID: () => input.auditId,
          now: () => input.now,
          runWrangler: (_name, operation) => {
            calls++;
            if (calls === 1) {
              const before = runSql({ sqlite: path }, [sql.preflight], false);
              database
                .prepare("UPDATE workspace_admission_policy SET rules_json = ?")
                .run(invalidRules);
              return before;
            }
            assert.deepEqual(operation, ["--command", sql.execution.join("\n")]);
            return runSql({ sqlite: path }, sql.execution, true);
          },
        }
      ),
      /refused/
    );
    assert.equal(calls, 2);
    assert.equal(policy(database).writes_frozen, 1);
    assert.equal(policy(database).revision, 7);
    assert.equal(audits(database).length, 0);
  });

  for (const assignment of [
    "updated_at = -1",
    "updated_by_user_id_snapshot = ''",
    "rules_json = ' ' || rules_json",
  ]) {
    it(`fences a concurrent restore of ${assignment}`, async (t) => {
      const { path, database } = fixture(t);
      const sql = buildMaintenanceSql({
        action: "unfreeze",
        expectedRevision: 7,
        auditId: "restore",
        now: 100,
        before: parseStoredAdmissionPolicy(policy(database)),
      });
      let calls = 0;
      await assert.rejects(
        run(
          { database: "production", action: "unfreeze", expectedRevision: 7, execute: true },
          {
            randomUUID: () => "restore",
            now: () => 100,
            runWrangler: (_name, operation) => {
              calls++;
              const statements = calls === 1 ? [sql.preflight] : sql.execution;
              assert.deepEqual(operation, ["--command", statements.join("\n")]);
              const output = runSql({ sqlite: path }, statements, calls > 1);
              if (calls === 1) database.exec(`UPDATE workspace_admission_policy SET ${assignment}`);
              return output;
            },
          }
        ),
        /refused/
      );
      assert.equal(calls, 2);
      assert.equal(policy(database).writes_frozen, 1);
      assert.equal(policy(database).revision, 7);
      assert.equal(audits(database).length, 0);
    });
  }

  for (const output of [
    "{}",
    "[]",
    '[{"success":true,"results":[]}]',
    '[{"success":false,"results":[]},{"success":true,"results":[]},{"success":true,"results":[]}]',
  ]) {
    it(`rejects malformed or aggregate remote output ${output}`, async () => {
      await assert.rejects(
        run(
          { database: "production", action: "freeze", expectedRevision: 7, execute: true },
          {
            runWrangler: () => output,
          }
        ),
        /Malformed|Missing/
      );
    });
  }
});
