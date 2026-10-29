import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyAdmissionRules } from "@open-inspect/shared/admission-settings";
import { AdmissionPolicyStore } from "../../src/db/admission-policy-store";
import type { SqlStatement } from "../../src/db/sql-database";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, sqlDatabase } from "./helpers";

async function resetPolicy() {
  await env.DB.prepare("DELETE FROM workspace_admission_policy").run();
  await env.DB.prepare(
    "INSERT INTO workspace_admission_policy (id, schema_version, revision, rules_json) VALUES (1, 1, 0, ?)"
  )
    .bind(JSON.stringify(emptyAdmissionRules()))
    .run();
}

beforeEach(async () => {
  await cleanD1Tables();
  await resetPolicy();
  await seedActiveUser("admission-admin");
  await env.DB.prepare(
    "UPDATE user_role_assignments SET role_id = 'role_builtin_administrator' WHERE user_id = 'admission-admin'"
  ).run();
});
afterEach(async () => {
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_admission_audit");
  await resetPolicy();
  await cleanD1Tables();
});

describe("AdmissionPolicyStore (D1)", () => {
  const input = {
    expectedRevision: 0,
    rules: { ...emptyAdmissionRules(), allowedEmailDomains: ["example.com"] },
    actorUserId: "admission-admin",
    requestId: "request",
    now: 100,
    deploymentHash: "baseline",
  };

  it("enforces CAS and canonical no-ops with durable operation audit", async () => {
    const store = new AdmissionPolicyStore(sqlDatabase(env.DB));
    expect((await store.replace({ ...input, before: await store.get() })).status).toBe("applied");
    expect(
      (await store.replace({ ...input, before: await store.get(), expectedRevision: 1 })).status
    ).toBe("no_op");
    expect((await store.replace({ ...input, before: await store.get() })).status).toBe("conflict");
    expect((await store.get()).revision).toBe(1);
    const audits = await env.DB.prepare(
      "SELECT operation_result, metadata_json FROM authorization_audit_events WHERE action = 'workspace.admission_policy_updated' ORDER BY rowid"
    ).all();
    expect(audits.results.map((row) => row.operation_result)).toEqual([
      "applied",
      "no_op",
      "rejected",
    ]);
    expect(audits.results.map((row) => JSON.parse(row.metadata_json as string).requested)).toEqual([
      { expectedRevision: 0 },
      { expectedRevision: 1 },
      { expectedRevision: 0 },
    ]);
  });

  it("rejects a demoted actor in the same batch", async () => {
    const db = sqlDatabase(env.DB);
    const store = new AdmissionPolicyStore({
      prepare: db.prepare.bind(db),
      async batch<T>(statements: SqlStatement[]) {
        await env.DB.exec(
          "UPDATE user_role_assignments SET role_id = 'role_builtin_member' WHERE user_id = 'admission-admin'"
        );
        return db.batch<T>(statements);
      },
    });
    expect((await store.replace({ ...input, before: await store.get() })).status).toBe(
      "actor_authorization_changed"
    );
    expect((await store.get()).revision).toBe(0);
  });

  it("does not change policy when D1 cannot insert the required audit", async () => {
    await env.DB.exec(
      "CREATE TRIGGER fail_admission_audit BEFORE INSERT ON authorization_audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END"
    );
    const store = new AdmissionPolicyStore(sqlDatabase(env.DB));
    await expect(store.replace({ ...input, before: await store.get() })).rejects.toThrow();
    expect((await store.get()).revision).toBe(0);
  });

  it.each(["future-revision", "raw-json", "metadata"])(
    "fences the caller's preimage against a concurrent %s change in D1",
    async (change) => {
      const db = sqlDatabase(env.DB);
      const store = new AdmissionPolicyStore({
        prepare: db.prepare.bind(db),
        async batch<T>(statements: SqlStatement[]) {
          if (change === "future-revision")
            await env.DB.exec("UPDATE workspace_admission_policy SET revision = 1");
          if (change === "raw-json")
            await env.DB.exec(
              "UPDATE workspace_admission_policy SET rules_json = ' ' || rules_json"
            );
          if (change === "metadata")
            await env.DB.exec("UPDATE workspace_admission_policy SET updated_at = 99");
          return db.batch<T>(statements);
        },
      });
      const before = await store.get();
      expect(
        (
          await store.replace({
            ...input,
            before,
            expectedRevision: change === "future-revision" ? 1 : 0,
          })
        ).status
      ).toBe("conflict");
      expect((await store.get()).rules).toEqual(emptyAdmissionRules());
      expect(
        await env.DB.prepare(
          "SELECT operation_result FROM authorization_audit_events WHERE action = 'workspace.admission_policy_updated'"
        ).first()
      ).toEqual({ operation_result: "rejected" });
    }
  );

  it("fails closed rather than recreating a missing singleton", async () => {
    await env.DB.exec("DELETE FROM workspace_admission_policy");
    await expect(new AdmissionPolicyStore(sqlDatabase(env.DB)).get()).rejects.toThrow();
  });
});
