import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyAdmissionRules,
  MAX_MANAGED_ADMISSION_RULES,
} from "@open-inspect/shared/admission-settings";
import { AdmissionPolicyStore } from "./admission-policy-store";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import type { SqlDatabase, SqlStatement } from "./sql-database";

const migrations = fileURLToPath(
  new NodeURL("../../../../terraform/d1/migrations", import.meta.url)
);

describe("AdmissionPolicyStore (Node SQLite)", () => {
  let sqlite: DatabaseSync;
  let db: SqlDatabase;
  let store: AdmissionPolicyStore;
  const input = {
    expectedRevision: 0,
    rules: { ...emptyAdmissionRules(), allowedEmails: ["a@example.com"] },
    actorUserId: "actor",
    requestId: "request",
    now: 100,
    deploymentHash: "baseline-hash",
  };

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(sqlite, migrations);
    db = createNodeSqlDatabase(sqlite);
    store = new AdmissionPolicyStore(db);
    sqlite.exec(`INSERT INTO users (id, created_at, updated_at) VALUES ('actor', 1, 1);
      UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = 'actor';`);
  });
  afterEach(() => sqlite.close());

  function unfreeze() {
    sqlite.exec("UPDATE workspace_admission_policy SET writes_frozen = 0");
  }
  function audit() {
    return sqlite
      .prepare(
        "SELECT * FROM authorization_audit_events WHERE action = 'workspace.admission_policy_updated' ORDER BY rowid DESC"
      )
      .get() as { operation_result: string; reason_code: string; metadata_json: string };
  }

  it("seeds a frozen empty singleton and does not reseed on migration rerun", async () => {
    expect(await store.get()).toEqual({
      rules: emptyAdmissionRules(),
      rulesJson: JSON.stringify(emptyAdmissionRules()),
      revision: 0,
      updatedAt: null,
      updatedByUserId: null,
      writesFrozen: true,
    });
    expect((await store.replace({ ...input, before: await store.get() })).status).toBe(
      "maintenance"
    );
    expect(audit().operation_result).toBe("rejected");
    unfreeze();
    await store.replace({ ...input, before: await store.get() });
    expect(applyMigrations(sqlite, migrations)).toEqual([]);
    expect((await store.get()).revision).toBe(1);
  });

  it("atomically applies CAS, canonical no-ops, and stale rejections with audit metadata", async () => {
    unfreeze();
    expect(await store.replace({ ...input, before: await store.get() })).toMatchObject({
      status: "applied",
      policy: { revision: 1, updatedAt: 100, updatedByUserId: "actor" },
    });
    expect(JSON.parse(audit().metadata_json)).toEqual({
      requested: { expectedRevision: 0 },
      currentRevision: 0,
      resultRevision: 1,
      deploymentHash: "baseline-hash",
      before: emptyAdmissionRules(),
      after: input.rules,
    });
    expect(
      (
        await store.replace({
          ...input,
          before: await store.get(),
          expectedRevision: 1,
          now: 200,
          rules: { ...input.rules, allowedEmails: [" A@EXAMPLE.COM ", "a@example.com"] },
        })
      ).status
    ).toBe("no_op");
    expect((await store.get()).updatedAt).toBe(100);
    expect(audit().operation_result).toBe("no_op");
    expect((await store.replace({ ...input, before: await store.get() })).status).toBe("conflict");
    expect(audit().operation_result).toBe("rejected");
    expect((await store.get()).revision).toBe(1);
  });

  it.each(["role_builtin_owner", "role_builtin_administrator"])(
    "accepts canonical %s",
    async (roleId) => {
      unfreeze();
      sqlite
        .prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = 'actor'")
        .run(roleId);
      expect((await store.replace({ ...input, before: await store.get() })).status).toBe("applied");
    }
  );

  it("keeps full before/after audit metadata below 30 KiB at the managed limit", async () => {
    unfreeze();
    const domain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}`;
    const rules = (prefix: string) => ({
      ...emptyAdmissionRules(),
      allowedEmails: Array.from(
        { length: MAX_MANAGED_ADMISSION_RULES },
        (_, index) => `${`${prefix}${index}`.padEnd(64, "a")}@${domain}`
      ).sort(),
    });
    await store.replace({ ...input, before: await store.get(), rules: rules("old") });
    await store.replace({
      ...input,
      before: await store.get(),
      expectedRevision: 1,
      rules: rules("new"),
    });
    expect(JSON.parse(audit().metadata_json)).toMatchObject({
      requested: { expectedRevision: 1 },
      before: rules("old"),
      after: rules("new"),
    });
    expect(new TextEncoder().encode(audit().metadata_json).byteLength).toBeLessThan(30 * 1024);
  });

  it("denies a canonical role ID/key whose persisted system flag is corrupted", async () => {
    unfreeze();
    sqlite.exec(`PRAGMA ignore_check_constraints = ON;
      UPDATE roles SET is_system = 0 WHERE id = 'role_builtin_owner';
      PRAGMA ignore_check_constraints = OFF;`);
    expect((await store.replace({ ...input, before: await store.get() })).status).toBe(
      "actor_authorization_changed"
    );
    expect((await store.get()).revision).toBe(0);
    expect(audit().operation_result).toBe("denied");
  });

  it.each(["suspend", "demote", "custom"])(
    "revalidates a stale actor at batch time: %s",
    async (change) => {
      unfreeze();
      const racingStore = new AdmissionPolicyStore({
        prepare: db.prepare.bind(db),
        batch<T>(statements: SqlStatement[]) {
          if (change === "suspend")
            sqlite.exec("UPDATE users SET suspended_at = 10 WHERE id = 'actor'");
          if (change === "demote")
            sqlite.exec(
              "UPDATE user_role_assignments SET role_id = 'role_builtin_member' WHERE user_id = 'actor'"
            );
          if (change === "custom")
            sqlite.exec(`INSERT INTO roles (id, name, normalized_name) VALUES ('custom', 'Custom manager', 'custom manager');
          INSERT INTO role_permissions VALUES ('custom', 'workspace.members.manage');
          UPDATE user_role_assignments SET role_id = 'custom' WHERE user_id = 'actor';`);
          return db.batch<T>(statements);
        },
      });
      expect((await racingStore.replace({ ...input, before: await store.get() })).status).toBe(
        "actor_authorization_changed"
      );
      expect((await store.get()).revision).toBe(0);
      expect(audit().operation_result).toBe("denied");
    }
  );

  it.each(["revision", "freeze", "raw-json", "metadata"])(
    "rejects a concurrent %s change inside the batch",
    async (change) => {
      unfreeze();
      const racingStore = new AdmissionPolicyStore({
        prepare: db.prepare.bind(db),
        batch<T>(statements: SqlStatement[]) {
          if (change === "freeze")
            sqlite.exec("UPDATE workspace_admission_policy SET writes_frozen = 1");
          if (change === "revision")
            sqlite.exec("UPDATE workspace_admission_policy SET revision = 1");
          if (change === "raw-json")
            sqlite.exec("UPDATE workspace_admission_policy SET rules_json = ' ' || rules_json");
          if (change === "metadata")
            sqlite.exec("UPDATE workspace_admission_policy SET updated_at = 99");
          return db.batch<T>(statements);
        },
      });
      expect((await racingStore.replace({ ...input, before: await store.get() })).status).toBe(
        change === "freeze" ? "maintenance" : "conflict"
      );
      expect((await store.get()).rules).toEqual(emptyAdmissionRules());
    }
  );

  it("leaves policy untouched if the required audit insert fails", async () => {
    unfreeze();
    sqlite.exec(
      "CREATE TRIGGER fail_policy_audit BEFORE INSERT ON authorization_audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END"
    );
    await expect(store.replace({ ...input, before: await store.get() })).rejects.toThrow(
      "audit unavailable"
    );
    expect((await store.get()).revision).toBe(0);
    expect(audit()).toBeUndefined();
  });

  it("never reconciles a future expected revision with a newer row after the caller's read", async () => {
    unfreeze();
    const before = await store.get();
    sqlite.exec("UPDATE workspace_admission_policy SET revision = 1");
    expect((await store.replace({ ...input, before, expectedRevision: 1 })).status).toBe(
      "conflict"
    );
    expect((await store.get()).rules).toEqual(emptyAdmissionRules());
    expect(audit().operation_result).toBe("rejected");
  });

  it("rolls back the audit if the policy update fails", async () => {
    unfreeze();
    sqlite.exec(
      "CREATE TRIGGER fail_policy_write BEFORE UPDATE ON workspace_admission_policy BEGIN SELECT RAISE(ABORT, 'write unavailable'); END"
    );
    await expect(store.replace({ ...input, before: await store.get() })).rejects.toThrow(
      "write unavailable"
    );
    expect((await store.get()).revision).toBe(0);
    expect(audit()).toBeUndefined();
  });

  it.each(["missing", "json", "shape", "version"])(
    "fails closed for %s persisted state",
    async (corruption) => {
      if (corruption === "missing") sqlite.exec("DELETE FROM workspace_admission_policy");
      if (corruption === "json")
        sqlite.exec("UPDATE workspace_admission_policy SET rules_json = 'broken'");
      if (corruption === "shape")
        sqlite.exec("UPDATE workspace_admission_policy SET rules_json = '{}'");
      if (corruption === "version")
        sqlite.exec(
          "PRAGMA ignore_check_constraints = ON; UPDATE workspace_admission_policy SET schema_version = 2"
        );
      await expect(store.get()).rejects.toThrow();
    }
  );
});
