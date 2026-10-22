import { env } from "cloudflare:test";
import type { BuiltInRoleKey } from "@open-inspect/shared/rbac";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemberMergeService } from "../../src/authorization/member-merge";
import { AuthorizationService } from "../../src/authorization/service";
import type { SqlDatabase, SqlResult, SqlStatement } from "../../src/db/sql-database";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";
import {
  SEED_NOW_MS,
  getUserRow,
  insertCanonicalUser,
  insertIdentity,
} from "./identity-seed-helpers";

/**
 * Administrator-initiated member merges: the Slack-row/GitHub-row split a
 * workspace admin folds together from Settings → Workspace access.
 */

const ADMIN = "adad0000000000000000000000000000";
const OWNER = "0e0e0000000000000000000000000000";
const GITHUB_ROW = "aaaa1111111111111111111111111111";
const SLACK_ROW = "bbbb2222222222222222222222222222";

async function setRole(userId: string, role: BuiltInRoleKey): Promise<void> {
  await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
    .bind(`role_builtin_${role}`, userId)
    .run();
}

async function seedSplit(): Promise<void> {
  await insertCanonicalUser({
    id: GITHUB_ROW,
    email: "person@example.com",
    emailVerified: 1,
    displayName: "Person",
  });
  await insertIdentity({
    id: "i1111111111111111111111111111111",
    userId: GITHUB_ROW,
    provider: "github",
    providerUserId: "583231",
    issuer: "https://github.com",
  });
  await insertCanonicalUser({ id: SLACK_ROW, email: "person@corp.example", displayName: "P" });
  await insertIdentity({
    id: "i2222222222222222222222222222222",
    userId: SLACK_ROW,
    provider: "slack",
    providerUserId: "U0SLACK",
  });
  await env.DB.prepare(
    `INSERT INTO sessions (id, repo_owner, repo_name, status, created_at, updated_at, user_id)
     VALUES ('session-slack', 'acme', 'app', 'completed', ?, ?, ?)`
  )
    .bind(SEED_NOW_MS, SEED_NOW_MS, SLACK_ROW)
    .run();
}

function post(
  path: string,
  body: unknown,
  as: { userId: string; role: BuiltInRoleKey } = { userId: ADMIN, role: "administrator" }
): Promise<Response> {
  return serviceFetch(`https://cp.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    as,
  });
}

const SPLIT = { sourceUserId: SLACK_ROW, targetUserId: GITHUB_ROW };

describe("member merge routes", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("previews both members, their identities, and record counts without writing", async () => {
    await seedSplit();

    const response = await post("/members/merge/preview", SPLIT);

    expect(response.status).toBe(200);
    const preview = await response.json<Record<string, unknown>>();
    expect(preview).toMatchObject({
      source: {
        member: { userId: SLACK_ROW, email: "person@corp.example", role: { key: "member" } },
        identities: [{ provider: "slack", login: null, email: null }],
      },
      target: {
        member: { userId: GITHUB_ROW, email: "person@example.com" },
        identities: [{ provider: "github" }],
      },
      blocker: null,
      counts: { identitiesRepointed: 1, sessionsRepointed: 1, usersDeleted: 1 },
    });
    expect(await getUserRow(SLACK_ROW)).not.toBeNull();
  });

  it("merges the source into the target and audits the acting administrator", async () => {
    await seedSplit();

    const response = await post("/members/merge", SPLIT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sourceUserId: SLACK_ROW,
      targetUserId: GITHUB_ROW,
      counts: { identitiesRepointed: 1, sessionsRepointed: 1, usersDeleted: 1 },
    });
    expect(await getUserRow(SLACK_ROW)).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT user_id FROM user_identities WHERE provider = 'slack' AND provider_user_id = 'U0SLACK'"
      ).first()
    ).toEqual({ user_id: GITHUB_ROW });
    expect(
      await env.DB.prepare(
        `SELECT principal_kind, actor_user_id_snapshot, actor_service_snapshot, request_id,
                resource_id, target_user_id_snapshot, reason_code, operation_result
         FROM authorization_audit_events WHERE action = 'workspace.user_merged'`
      ).first()
    ).toEqual({
      principal_kind: "user",
      actor_user_id_snapshot: ADMIN,
      actor_service_snapshot: null,
      request_id: expect.not.stringMatching(/^operator-cli:/),
      resource_id: GITHUB_ROW,
      target_user_id_snapshot: SLACK_ROW,
      reason_code: "member_merge",
      operation_result: "applied",
    });
  });

  it("denies members without the merge grant", async () => {
    await seedSplit();

    for (const [userId, role] of [
      ["dddd0000000000000000000000000000", "member"],
      ["eeee0000000000000000000000000000", "viewer"],
    ] as const) {
      const response = await post("/members/merge", SPLIT, { userId, role });
      expect(response.status).toBe(403);
    }
    expect(await getUserRow(SLACK_ROW)).not.toBeNull();
  });

  it("rejects merging a member into itself", async () => {
    await seedSplit();

    const response = await post("/members/merge", {
      sourceUserId: GITHUB_ROW,
      targetUserId: GITHUB_ROW,
    });

    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown member", async () => {
    await seedSplit();

    const response = await post("/members/merge/preview", {
      sourceUserId: "cccc3333333333333333333333333333",
      targetUserId: GITHUB_ROW,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "member_not_found" });
  });

  it("reports a role conflict as a preview blocker and refuses the merge", async () => {
    await seedSplit();
    await setRole(GITHUB_ROW, "administrator");

    const preview = await post("/members/merge/preview", SPLIT);
    await expect(preview.json()).resolves.toMatchObject({
      blocker: "role_conflict",
      counts: null,
    });

    const merge = await post("/members/merge", SPLIT);
    expect(merge.status).toBe(409);
    await expect(merge.json()).resolves.toMatchObject({ code: "role_conflict" });
    expect(await getUserRow(SLACK_ROW)).not.toBeNull();
  });

  it("refuses to merge away the actor's own account", async () => {
    await seedSplit();
    await setRole(SLACK_ROW, "administrator");
    await setRole(GITHUB_ROW, "administrator");
    const self = { userId: SLACK_ROW, role: "administrator" } as const;

    const preview = await post("/members/merge/preview", SPLIT, self);
    await expect(preview.json()).resolves.toMatchObject({ blocker: "source_is_actor" });

    const merge = await post("/members/merge", SPLIT, self);
    expect(merge.status).toBe(409);
    await expect(merge.json()).resolves.toMatchObject({ code: "source_is_actor" });
  });

  it("lets the actor merge another account into their own", async () => {
    await seedSplit();
    await setRole(GITHUB_ROW, "administrator");
    await setRole(SLACK_ROW, "administrator");

    const response = await post("/members/merge", SPLIT, {
      userId: GITHUB_ROW,
      role: "administrator",
    });

    expect(response.status).toBe(200);
    expect(await getUserRow(SLACK_ROW)).toBeNull();
  });

  it("reserves Owner-account merges for Owners", async () => {
    await seedSplit();
    await setRole(GITHUB_ROW, "owner");
    await setRole(SLACK_ROW, "owner");

    const preview = await post("/members/merge/preview", SPLIT);
    await expect(preview.json()).resolves.toMatchObject({
      blocker: "owner_transfer_required",
      counts: null,
    });
    const denied = await post("/members/merge", SPLIT);
    expect(denied.status).toBe(403);
    expect(await getUserRow(SLACK_ROW)).not.toBeNull();

    const allowed = await post("/members/merge", SPLIT, { userId: OWNER, role: "owner" });
    expect(allowed.status).toBe(200);
    expect(await getUserRow(SLACK_ROW)).toBeNull();
  });

  it("rolls back when the actor loses the merge grant after preflight", async () => {
    await seedSplit();
    await insertCanonicalUser({ id: ADMIN, email: "admin@example.com" });
    await setRole(ADMIN, "administrator");
    let batchCount = 0;
    const racingDatabase: SqlDatabase = {
      prepare(query: string): SqlStatement {
        return env.DB.prepare(query) as unknown as SqlStatement;
      },
      async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
        batchCount += 1;
        // Batch 1 is the role preflight; batch 2 is the merge write.
        if (batchCount === 2) await setRole(ADMIN, "member");
        return env.DB.batch(statements as unknown as D1PreparedStatement[]) as Promise<
          SqlResult<T>[]
        >;
      },
    };
    const service = new MemberMergeService(
      racingDatabase,
      new AuthorizationService(sqlDatabase(env.DB)),
      new UserStore(sqlDatabase(env.DB))
    );

    await expect(
      service.merge({ ...SPLIT, actorUserId: ADMIN, requestId: "racing-merge" })
    ).rejects.toThrow("Actor authorization changed");
    expect(await getUserRow(SLACK_ROW)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'workspace.user_merged'"
      ).first()
    ).toEqual({ count: 0 });
  });
});
