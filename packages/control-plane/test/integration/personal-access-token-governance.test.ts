/**
 * Workspace governance of personal access tokens against real D1: the policy (kill switch,
 * lifetime cap, permission ceiling) applied to existing tokens and to issuing, and administrators
 * listing and revoking any member's tokens.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type {
  ListWorkspacePersonalAccessTokensResponse,
  PersonalAccessTokenPolicy,
  PersonalAccessTokenPolicySnapshot,
} from "@open-inspect/shared/types/personal-access-tokens";
import { PersonalAccessTokenStore } from "../../src/db/personal-access-tokens";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

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
