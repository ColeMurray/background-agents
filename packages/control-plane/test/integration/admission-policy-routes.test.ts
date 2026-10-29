import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admissionPolicySnapshotSchema,
  emptyAdmissionRules,
} from "@open-inspect/shared/admission-settings";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { AdmissionPolicyStore } from "../../src/db/admission-policy-store";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceRequestHeaders, type ServiceRequestInit } from "./helpers";

const url = "https://cp.test/settings/admission-policy";

async function resetPolicy() {
  await env.DB.prepare(
    `UPDATE workspace_admission_policy
    SET schema_version = 1, revision = 0, rules_json = ?, updated_at = NULL,
        updated_by_user_id_snapshot = NULL WHERE id = 1`
  )
    .bind(JSON.stringify(emptyAdmissionRules()))
    .run();
}

async function request(init?: ServiceRequestInit, overrides: Partial<WorkerBindings> = {}) {
  const headers = await serviceRequestHeaders(url, init);
  const executionCtx = createExecutionContext();
  const response = await routeRequest(
    new Request(url, { method: init?.method ?? "GET", headers, body: init?.body }),
    {
      ...env,
      ALLOWED_EMAILS: "recovery@example.com",
      UNSAFE_ALLOW_ALL_USERS: "false",
      ...overrides,
    },
    executionCtx
  );
  await waitOnExecutionContext(executionCtx);
  return response;
}

beforeEach(async () => {
  await cleanD1Tables();
  await resetPolicy();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_admission_route_audit");
  await resetPolicy();
  await cleanD1Tables();
});

describe("authenticated admission policy routes (D1)", () => {
  it("rejects and audits a future revision even when another writer commits it after the route read", async () => {
    const overrides = {
      ALLOWED_GITHUB_ORGS: Array.from({ length: 10 }, (_, i) => `org-${i}`).join(","),
    };
    const snapshot = admissionPolicySnapshotSchema.parse(
      await (await request(undefined, overrides)).json()
    );
    const get = AdmissionPolicyStore.prototype.get;
    const read = vi
      .spyOn(AdmissionPolicyStore.prototype, "get")
      .mockImplementationOnce(async function (this: AdmissionPolicyStore) {
        const before = await get.call(this);
        await env.DB.exec("UPDATE workspace_admission_policy SET revision = 1");
        return before;
      });
    const response = await request(
      {
        method: "PUT",
        headers: { "If-Match": snapshot.etag.replace("admission-0-", "admission-1-") },
        body: JSON.stringify({
          ...emptyAdmissionRules(),
          allowedGitHubOrganizations: ["forbidden-extra"],
        }),
      },
      overrides
    );
    expect(response.status).toBe(412);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT revision, rules_json FROM workspace_admission_policy").first()
    ).toEqual({ revision: 1, rules_json: JSON.stringify(emptyAdmissionRules()) });
    expect(
      await env.DB.prepare(
        "SELECT operation_result, reason_code FROM authorization_audit_events WHERE action = 'workspace.admission_policy_updated'"
      ).first()
    ).toEqual({ operation_result: "rejected", reason_code: "conflict" });
  });

  it.each(["owner", "administrator"] as const)(
    "persists and audits real %s GET/PUT requests, no-ops, and stale CAS",
    async (initialUserRole) => {
      const get = await request({ initialUserRole });
      expect(get.status).toBe(200);
      const before = admissionPolicySnapshotSchema.parse(await get.json());
      expect(get.headers.get("ETag")).toBe(before.etag);
      expect(get.headers.get("Cache-Control")).toBe("private, no-store");
      expect(before.managed).toEqual(emptyAdmissionRules());
      expect(before.editingDisabledReason).toBeNull();

      const rules = {
        ...emptyAdmissionRules(),
        allowedEmails: [" ZED@example.com ", "recovery@example.com"],
      };
      const put = await request({
        method: "PUT",
        headers: { "If-Match": before.etag },
        body: JSON.stringify(rules),
      });
      expect(put.status).toBe(200);
      const after = admissionPolicySnapshotSchema.parse(await put.json());
      expect(after.revision).toBe(1);
      expect(after.updatedByUserId).not.toBeNull();
      expect(after.managed.allowedEmails).toEqual(["recovery@example.com", "zed@example.com"]);
      expect(after.deployment.allowedEmails).toEqual(["recovery@example.com"]);
      expect(after.effective.allowedEmails).toEqual(after.managed.allowedEmails);
      expect(admissionPolicySnapshotSchema.parse(await (await request()).json())).toEqual(after);

      const noOp = await request({
        method: "PUT",
        headers: { "If-Match": after.etag },
        body: JSON.stringify(rules),
      });
      expect(noOp.status).toBe(200);
      expect(admissionPolicySnapshotSchema.parse(await noOp.json())).toEqual(after);
      const stale = await request({
        method: "PUT",
        headers: { "If-Match": before.etag },
        body: JSON.stringify(rules),
      });
      expect(stale.status).toBe(412);

      const audits = await env.DB.prepare(
        `SELECT operation_result, actor_user_id_snapshot, metadata_json
        FROM authorization_audit_events WHERE action = 'workspace.admission_policy_updated' ORDER BY rowid`
      ).all<{ operation_result: string; actor_user_id_snapshot: string; metadata_json: string }>();
      expect(audits.results.map((row) => row.operation_result)).toEqual([
        "applied",
        "no_op",
        "rejected",
      ]);
      expect(audits.results[0].actor_user_id_snapshot).toBe(after.updatedByUserId);
      expect(JSON.parse(audits.results[0].metadata_json)).toMatchObject({
        requested: { expectedRevision: 0 },
        before: before.managed,
        after: after.managed,
        currentRevision: 0,
        resultRevision: 1,
      });
    }
  );

  it("denies both reads and writes to a real custom role with member-management permission", async () => {
    const before = admissionPolicySnapshotSchema.parse(await (await request()).json());
    const actor = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'browser@test.local'"
    ).first<{ id: string }>();
    expect(actor).not.toBeNull();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO roles (id, name, normalized_name, is_system) VALUES ('admission-manager', 'Admission manager', 'admission manager', 0)"
      ),
      env.DB.prepare(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES ('admission-manager', 'workspace.members.manage')"
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'admission-manager' WHERE user_id = ?"
      ).bind(actor!.id),
    ]);
    for (const method of ["GET", "PUT"]) {
      const response = await request({
        method,
        headers: { "If-Match": before.etag },
        ...(method === "PUT" ? { body: JSON.stringify(emptyAdmissionRules()) } : {}),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "admission_policy_forbidden" });
    }
    expect(await env.DB.prepare("SELECT revision FROM workspace_admission_policy").first()).toEqual(
      { revision: 0 }
    );
    expect(
      await env.DB.prepare(
        "SELECT id FROM authorization_audit_events WHERE action = 'workspace.admission_policy_updated'"
      ).first()
    ).toBeNull();
  });

  it("keeps unsafe allow-all read-only for an authenticated administrator", async () => {
    const overrides = { UNSAFE_ALLOW_ALL_USERS: "true" };
    const get = await request(undefined, overrides);
    expect(get.status).toBe(200);
    const snapshot = admissionPolicySnapshotSchema.parse(await get.json());
    expect(snapshot.editingDisabledReason).toBe("unsafe_allow_all");
    const response = await request(
      {
        method: "PUT",
        headers: { "If-Match": snapshot.etag },
        body: JSON.stringify(emptyAdmissionRules()),
      },
      overrides
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "admission_policy_unsafe_allow_all",
    });
    expect(await env.DB.prepare("SELECT revision FROM workspace_admission_policy").first()).toEqual(
      { revision: 0 }
    );
    expect(
      await env.DB.prepare(
        "SELECT id FROM authorization_audit_events WHERE action = 'workspace.admission_policy_updated'"
      ).first()
    ).toBeNull();
  });

  it("returns 503 with unchanged persisted state when the operation audit fails", async () => {
    const before = admissionPolicySnapshotSchema.parse(await (await request()).json());
    await env.DB.prepare(
      `CREATE TRIGGER fail_admission_route_audit
      BEFORE INSERT ON authorization_audit_events WHEN NEW.action = 'workspace.admission_policy_updated'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`
    ).run();
    const response = await request({
      method: "PUT",
      headers: { "If-Match": before.etag },
      body: JSON.stringify({ ...emptyAdmissionRules(), allowedEmails: ["new@example.com"] }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "admission_policy_unavailable" });
    expect(admissionPolicySnapshotSchema.parse(await (await request()).json())).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT id FROM authorization_audit_events WHERE action = 'workspace.admission_policy_updated'"
      ).first()
    ).toBeNull();
  });
});
