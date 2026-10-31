/**
 * Workspace governance of personal access tokens against real D1: the policy (kill switch,
 * lifetime cap, permission ceiling) applied to existing tokens and to issuing, and administrators
 * listing and revoking any member's tokens.
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type {
  ListWorkspacePersonalAccessTokensResponse,
  PersonalAccessTokenPolicy,
  PersonalAccessTokenPolicySnapshot,
} from "@open-inspect/shared/types/personal-access-tokens";
import { PersonalAccessTokenPolicyStore } from "../../src/db/personal-access-token-policy";
import { PersonalAccessTokenStore } from "../../src/db/personal-access-tokens";
import { handleControlPlaneHttp } from "../../src/cloudflare/http-host";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, serviceRequestHeaders, sqlDatabase } from "./helpers";

const BASE = "https://cp.test";
const ADMIN = { userId: "aaaa1111aaaa1111aaaa1111aaaa1111", role: "administrator" } as const;
const MEMBER = { userId: "bbbb2222bbbb2222bbbb2222bbbb2222", role: "member" } as const;
const OTHER = { userId: "cccc3333cccc3333cccc3333cccc3333", role: "member" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN: PersonalAccessTokenPolicy = {
  enabled: true,
  maxLifetimeDays: null,
  allowedPermissions: null,
};

async function seedUsers() {
  for (const as of [ADMIN, MEMBER, OTHER]) {
    expect((await serviceFetch(`${BASE}/me/authorization`, { as })).status).toBe(200);
  }
}

async function issueToken(userId: string, permissions: PermissionId[], name = "laptop") {
  const result = await new PersonalAccessTokenStore(env.DB).issue({
    userId,
    name,
    permissions,
    expiresAt: Date.now() + 300 * DAY_MS,
    now: Date.now(),
    requestId: "governance",
  });
  if (result.kind !== "issued") throw new Error("token was not issued");
  return result.token;
}

function withToken(token: string, path: string) {
  return SELF.fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function policy(as = ADMIN) {
  const response = await serviceFetch(`${BASE}/settings/personal-access-token-policy`, { as });
  expect(response.status).toBe(200);
  return response.json<PersonalAccessTokenPolicySnapshot>();
}

async function setPolicy(rules: Partial<PersonalAccessTokenPolicy>, revision?: number) {
  const current = await policy();
  const response = await serviceFetch(`${BASE}/settings/personal-access-token-policy`, {
    as: ADMIN,
    method: "PUT",
    headers: { "If-Match": `"pat-policy-${revision ?? current.revision}"` },
    body: JSON.stringify({ ...OPEN, ...rules }),
  });
  return response;
}

function issueRequest(as: typeof MEMBER, body: Record<string, unknown>) {
  return serviceFetch(`${BASE}/personal-access-tokens`, {
    as,
    method: "POST",
    body: JSON.stringify({
      name: "laptop",
      permissions: ["sessions.read"],
      expiresInDays: 30,
      ...body,
    }),
  });
}

beforeEach(async () => {
  await cleanD1Tables();
  await seedUsers();
});
afterEach(cleanD1Tables);

describe("the workspace token policy", () => {
  it("is managed by administrators under a revision, and every change is audited", async () => {
    const before = await policy();
    expect(before).toMatchObject({ ...OPEN, revision: 0, updatedAt: null });

    expect(
      (await serviceFetch(`${BASE}/settings/personal-access-token-policy`, { as: MEMBER })).status
    ).toBe(403);
    const missingPrecondition = await serviceFetch(
      `${BASE}/settings/personal-access-token-policy`,
      {
        as: ADMIN,
        method: "PUT",
        body: JSON.stringify(OPEN),
      }
    );
    expect(missingPrecondition.status).toBe(428);

    const applied = await setPolicy({ maxLifetimeDays: 30, allowedPermissions: ["sessions.read"] });
    expect(applied.status).toBe(200);
    expect(applied.headers.get("ETag")).toBe('"pat-policy-1"');
    await expect(applied.json()).resolves.toMatchObject({
      maxLifetimeDays: 30,
      allowedPermissions: ["sessions.read"],
      revision: 1,
      updatedByUserId: ADMIN.userId,
    });

    const stale = await setPolicy({ enabled: false }, 0);
    expect(stale.status).toBe(412);
    expect(stale.headers.get("ETag")).toBe('"pat-policy-1"');
    expect((await policy()).enabled).toBe(true);

    const audits = await env.DB.prepare(
      `SELECT actor_user_id_snapshot, metadata_json FROM authorization_audit_events
        WHERE action = 'workspace.personal_access_token_policy_updated'`
    ).all<{ actor_user_id_snapshot: string; metadata_json: string }>();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0]?.actor_user_id_snapshot).toBe(ADMIN.userId);
    expect(JSON.parse(audits.results[0]!.metadata_json)).toEqual({
      before: OPEN,
      requested: { expectedRevision: 0 },
      after: { ...OPEN, maxLifetimeDays: 30, allowedPermissions: ["sessions.read"] },
    });
  });

  it("refuses a ceiling that allows a permission without its prerequisite", async () => {
    const response = await setPolicy({ allowedPermissions: ["sessions.read", "skills.manage"] });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "permission_prerequisite_missing",
      permission: "skills.manage",
      requires: "skills.read",
    });
    expect((await policy()).revision).toBe(0);

    const consistent = await setPolicy({
      allowedPermissions: ["sessions.read", "skills.read", "skills.manage"],
    });
    expect(consistent.status).toBe(200);
  });

  it.each(["owner", "administrator", "custom"])(
    "allows an active %s with the management permission to save the policy",
    async (role) => {
      if (role === "custom") {
        await env.DB.prepare(
          `INSERT INTO roles (id, name, normalized_name) VALUES ('pat-manager', 'PAT manager', 'pat manager')`
        ).run();
        await env.DB.prepare(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ('pat-manager', 'workspace.personal_access_tokens.manage')`
        ).run();
      }
      await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
        .bind(role === "custom" ? "pat-manager" : `role_builtin_${role}`, ADMIN.userId)
        .run();

      expect((await setPolicy({ enabled: false })).status).toBe(200);
      expect(await policy()).toMatchObject({ enabled: false, revision: 1 });
    }
  );

  it.each(["suspended", "demoted", "permission removed", "eligible role change"])(
    "revalidates the admitted policy writer at commit: %s",
    async (change) => {
      await env.DB.prepare(
        `INSERT INTO roles (id, name, normalized_name) VALUES ('pat-manager', 'PAT manager', 'pat manager')`
      ).run();
      await env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('pat-manager', 'workspace.personal_access_tokens.manage')`
      ).run();
      if (change === "permission removed") {
        await env.DB.prepare(
          "UPDATE user_role_assignments SET role_id = 'pat-manager' WHERE user_id = ?"
        )
          .bind(ADMIN.userId)
          .run();
      }
      const before = await policy();
      const body = JSON.stringify({ ...OPEN, enabled: false });
      const url = `${BASE}/settings/personal-access-token-policy`;
      const headers = await serviceRequestHeaders(url, {
        as: ADMIN,
        method: "PUT",
        headers: { "If-Match": `"pat-policy-${before.revision}"` },
        body,
      });
      const db = sqlDatabase(env.DB);
      let policyWritePrepared = false;
      let raced = false;
      const requestEnv = createCloudflareEnv(env);
      requestEnv.DB = {
        prepare(query) {
          if (query.includes("workspace.personal_access_token_policy_updated")) {
            policyWritePrepared = true;
          }
          return db.prepare(query);
        },
        async batch(statements) {
          // Admission has succeeded; change live authority just before the policy/audit transaction.
          if (policyWritePrepared && !raced) {
            raced = true;
            if (change === "suspended") {
              await env.DB.prepare("UPDATE users SET suspended_at = 10 WHERE id = ?")
                .bind(ADMIN.userId)
                .run();
            } else if (change === "permission removed") {
              await env.DB.prepare(
                "DELETE FROM role_permissions WHERE role_id = 'pat-manager'"
              ).run();
            } else {
              await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
                .bind(change === "demoted" ? "role_builtin_member" : "pat-manager", ADMIN.userId)
                .run();
            }
          }
          return db.batch(statements);
        },
      };
      const executionCtx = createExecutionContext();
      const response = await handleControlPlaneHttp(
        new Request(url, { method: "PUT", headers, body }),
        requestEnv,
        executionCtx
      );
      await waitOnExecutionContext(executionCtx);

      expect(raced).toBe(true);
      const authorized = change === "eligible role change";
      expect(response.status).toBe(authorized ? 200 : 403);
      if (!authorized) {
        await expect(response.json()).resolves.toMatchObject({
          code: "actor_authorization_changed",
        });
      }
      const stored = await new PersonalAccessTokenPolicyStore(env.DB).get();
      expect(stored).toEqual(
        authorized
          ? expect.objectContaining({ enabled: false, revision: before.revision + 1 })
          : before
      );
      const audits = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM authorization_audit_events
         WHERE action = 'workspace.personal_access_token_policy_updated' AND operation_result = 'applied'`
      ).first<{ count: number }>();
      expect(audits?.count).toBe(authorized ? 1 : 0);
    }
  );

  it("audits only an update whose before is the revision it replaced", async () => {
    // A request read revision 0; another administrator then saved revision 1.
    const stale = await policy();
    expect((await setPolicy({ maxLifetimeDays: 90 })).status).toBe(200);
    const store = new PersonalAccessTokenPolicyStore(env.DB);
    vi.spyOn(store, "get").mockResolvedValueOnce(stale);

    const result = await store.replace({
      expectedRevision: 1,
      policy: { ...OPEN, enabled: false },
      actorUserId: ADMIN.userId,
      requestId: "stale-before",
      now: Date.now(),
    });
    expect(result.status).toBe("conflict");
    expect((await policy()).enabled).toBe(true);
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM authorization_audit_events
        WHERE action = 'workspace.personal_access_token_policy_updated'`
    ).first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  it("reports the policy its own update wrote, not a later read", async () => {
    const store = new PersonalAccessTokenPolicyStore(env.DB);
    const get = store.get.bind(store);
    // Any read after the update sees another administrator's later save.
    vi.spyOn(store, "get")
      .mockImplementationOnce(get)
      .mockResolvedValue({
        ...OPEN,
        maxLifetimeDays: 7,
        revision: 9,
        updatedAt: 0,
        updatedByUserId: OTHER.userId,
      });

    await expect(
      store.replace({
        expectedRevision: 0,
        policy: { ...OPEN, maxLifetimeDays: 30 },
        actorUserId: ADMIN.userId,
        requestId: "returning",
        now: 1234,
      })
    ).resolves.toEqual({
      status: "applied",
      policy: {
        ...OPEN,
        maxLifetimeDays: 30,
        revision: 1,
        updatedAt: 1234,
        updatedByUserId: ADMIN.userId,
      },
    });
  });

  it("issues nothing once the policy has moved past the revision a request was checked against", async () => {
    const checked = (await policy()).revision;
    expect((await setPolicy({ maxLifetimeDays: 90 })).status).toBe(200);
    const store = new PersonalAccessTokenStore(env.DB);
    const request = {
      userId: MEMBER.userId,
      name: "raced",
      permissions: ["sessions.read"] satisfies PermissionId[],
      expiresAt: Date.now() + 30 * DAY_MS,
      now: Date.now(),
      requestId: "policy-race",
    };

    await expect(store.issue({ ...request, policyRevision: checked })).resolves.toEqual({
      kind: "policy_changed",
    });
    expect(await store.list(MEMBER.userId)).toEqual([]);
    const created = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM authorization_audit_events
        WHERE action = 'personal_access_token.created'`
    ).first<{ count: number }>();
    expect(created?.count).toBe(0);

    await expect(store.issue({ ...request, policyRevision: checked + 1 })).resolves.toMatchObject({
      kind: "issued",
    });
  });

  it("tells every user its rules, without the revision", async () => {
    await setPolicy({ maxLifetimeDays: 90 });
    const response = await serviceFetch(`${BASE}/personal-access-tokens/policy`, { as: MEMBER });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ...OPEN, maxLifetimeDays: 90 });
  });

  it("turns every token off, and back on, without revoking any", async () => {
    const { token } = await issueToken(MEMBER.userId, ["sessions.read"]);
    expect((await withToken(token, "/sessions")).status).toBe(200);

    expect((await setPolicy({ enabled: false })).status).toBe(200);
    const refused = await withToken(token, "/sessions");
    expect(refused.status).toBe(401);
    await expect(refused.json()).resolves.toEqual({
      error: "Personal access tokens are disabled for this workspace",
    });
    const issue = await issueRequest(MEMBER, {});
    expect(issue.status).toBe(403);
    await expect(issue.json()).resolves.toMatchObject({ code: "personal_access_tokens_disabled" });

    expect((await setPolicy({ enabled: true })).status).toBe(200);
    expect((await withToken(token, "/sessions")).status).toBe(200);
  });

  it("caps lifetimes, ending existing tokens early and refusing longer new ones", async () => {
    const created = await issueToken(MEMBER.userId, ["sessions.read"]);
    await env.DB.prepare("UPDATE personal_access_tokens SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 40 * DAY_MS, created.id)
      .run();
    expect((await withToken(created.token, "/sessions")).status).toBe(200);

    await setPolicy({ maxLifetimeDays: 30 });
    expect((await withToken(created.token, "/sessions")).status).toBe(401);
    const tooLong = await issueRequest(MEMBER, { expiresInDays: 90 });
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({
      code: "lifetime_exceeds_policy",
      maxLifetimeDays: 30,
    });
    expect((await issueRequest(MEMBER, { expiresInDays: 30 })).status).toBe(201);
  });

  it("narrows existing grants to the permission ceiling and refuses grants beyond it", async () => {
    const { token } = await issueToken(MEMBER.userId, ["sessions.read", "automations.read"]);
    await setPolicy({ allowedPermissions: ["automations.read"] });

    expect((await withToken(token, "/automations")).status).toBe(200);
    const narrowed = await withToken(token, "/sessions");
    expect(narrowed.status).toBe(403);
    await expect(narrowed.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "sessions.read",
    });

    const beyond = await issueRequest(MEMBER, { permissions: ["sessions.read"] });
    expect(beyond.status).toBe(400);
    await expect(beyond.json()).resolves.toMatchObject({
      code: "permission_not_allowed_by_policy",
      permission: "sessions.read",
    });
  });
});

describe("administering members' tokens", () => {
  it("lists every member's tokens with their owners, a page at a time", async () => {
    await issueToken(MEMBER.userId, ["sessions.read"], "member laptop");
    await issueToken(OTHER.userId, ["automations.read"], "other laptop");

    const first = await serviceFetch(`${BASE}/settings/personal-access-tokens?limit=1`, {
      as: ADMIN,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const page1 = await first.json<ListWorkspacePersonalAccessTokensResponse>();
    expect(page1.tokens).toHaveLength(1);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const second = await serviceFetch(
      `${BASE}/settings/personal-access-tokens?limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      { as: ADMIN }
    );
    const page2 = await second.json<ListWorkspacePersonalAccessTokensResponse>();
    expect(page2.nextCursor).toBeNull();
    expect(
      [...page1.tokens, ...page2.tokens].map((token) => [token.name, token.owner.userId]).sort()
    ).toEqual(
      [
        ["member laptop", MEMBER.userId],
        ["other laptop", OTHER.userId],
      ].sort()
    );
    expect(JSON.stringify([page1, page2])).not.toMatch(/oi_pat_[0-9a-f]{64}/);

    expect(
      (await serviceFetch(`${BASE}/settings/personal-access-tokens`, { as: MEMBER })).status
    ).toBe(403);
  });

  it("revokes any member's token, attributing the revocation to the administrator", async () => {
    const created = await issueToken(MEMBER.userId, ["sessions.read"]);
    const response = await serviceFetch(`${BASE}/settings/personal-access-tokens/${created.id}`, {
      as: ADMIN,
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect((await withToken(created.token, "/sessions")).status).toBe(401);
    expect(
      await env.DB.prepare(
        `SELECT actor_user_id_snapshot, target_user_id_snapshot FROM authorization_audit_events
          WHERE action = 'personal_access_token.revoked'`
      ).first()
    ).toEqual({ actor_user_id_snapshot: ADMIN.userId, target_user_id_snapshot: MEMBER.userId });

    expect(
      (
        await serviceFetch(`${BASE}/settings/personal-access-tokens/${created.id}`, {
          as: ADMIN,
          method: "DELETE",
        })
      ).status
    ).toBe(404);
  });

  it("revokes all of one member's tokens and no one else's", async () => {
    const member = [
      await issueToken(MEMBER.userId, ["sessions.read"], "one"),
      await issueToken(MEMBER.userId, ["sessions.read"], "two"),
    ];
    const other = await issueToken(OTHER.userId, ["sessions.read"]);

    const response = await serviceFetch(`${BASE}/members/${MEMBER.userId}/personal-access-tokens`, {
      as: ADMIN,
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: 2 });
    for (const { token } of member) expect((await withToken(token, "/sessions")).status).toBe(401);
    expect((await withToken(other.token, "/sessions")).status).toBe(200);
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM authorization_audit_events
        WHERE action = 'personal_access_token.revoked' AND target_user_id_snapshot = ?`
    )
      .bind(MEMBER.userId)
      .first<{ count: number }>();
    expect(audits?.count).toBe(2);
  });

  it("revokes a token the member issues while revoke-all runs", async () => {
    await issueToken(MEMBER.userId, ["sessions.read"], "before");
    const store = new PersonalAccessTokenStore(env.DB);
    const list = store.list.bind(store);
    let raced: Awaited<ReturnType<typeof issueToken>> | undefined;
    vi.spyOn(store, "list").mockImplementation(async (userId) => {
      const tokens = await list(userId);
      // The member issues another token just after the first pass has listed theirs.
      raced ??= await issueToken(MEMBER.userId, ["sessions.read"], "during");
      return tokens;
    });

    await expect(
      store.revokeAll({
        userId: MEMBER.userId,
        actorUserId: ADMIN.userId,
        now: Date.now(),
        requestId: "revoke-all-race",
      })
    ).resolves.toEqual({ revoked: 2, complete: true });
    expect((await withToken(raced!.token, "/sessions")).status).toBe(401);
    expect(await list(MEMBER.userId)).toEqual([]);
  });

  it("reports a member who keeps issuing tokens through every revoke-all pass", async () => {
    await issueToken(MEMBER.userId, ["sessions.read"], "first");
    const store = new PersonalAccessTokenStore(env.DB);
    const list = store.list.bind(store);
    vi.spyOn(store, "list").mockImplementation(async (userId) => {
      const tokens = await list(userId);
      await issueToken(MEMBER.userId, ["sessions.read"], "again");
      return tokens;
    });

    await expect(
      store.revokeAll({
        userId: MEMBER.userId,
        actorUserId: ADMIN.userId,
        now: Date.now(),
        requestId: "revoke-all-flood",
      })
    ).resolves.toEqual({ revoked: 5, complete: false });
  });

  it("is never reachable with a token, even an administrator's", async () => {
    const { token } = await issueToken(ADMIN.userId, ["sessions.read"]);
    for (const path of [
      "/settings/personal-access-tokens",
      "/settings/personal-access-token-policy",
    ]) {
      const response = await withToken(token, path);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "personal_access_token_not_accepted",
      });
    }
  });
});
