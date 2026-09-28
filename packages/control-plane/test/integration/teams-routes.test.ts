import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type { Team } from "@open-inspect/shared/types/teams";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, serviceFetch, sqlDatabase } from "./helpers";

const BASE = "https://test.local";
const OWNER = "11111111111111111111111111111111";
const MEMBER = "22222222222222222222222222222222";
const OTHER = "33333333333333333333333333333333";

async function request(path: string, method = "GET", body?: object) {
  return serviceFetch(`${BASE}${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function setRole(userId: string, role: "member" | "administrator") {
  await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
    .bind(BUILT_IN_ROLE_REGISTRY[role].id, userId)
    .run();
}

async function auditEvents(teamId: string) {
  const result = await env.DB.prepare(
    "SELECT action, team_id, target_user_id_snapshot, metadata_json FROM authorization_audit_events WHERE resource_type = 'team' AND team_id = ? ORDER BY occurred_at, id"
  )
    .bind(teamId)
    .all();
  return result.results;
}

describe("team routes", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(MEMBER);
    await seedActiveUser(OTHER);
    await request("/me/authorization");
  });

  it("starts without teams and lets an administrator create, rename, archive and restore", async () => {
    expect((await request("/me/teams")).status).toBe(200);
    expect(await (await request("/me/teams")).json()).toEqual({ teams: [] });
    await setRole(OWNER, "administrator");
    const created = await request("/teams", "POST", { slug: "engineering", name: "Engineering" });
    expect(created.status).toBe(201);
    const team = (await created.json()) as { id: string; capabilities: { canArchive: boolean } };
    expect(team.capabilities.canArchive).toBe(true);
    expect(await (await request("/me/teams")).json()).toMatchObject({
      teams: [{ id: team.id, role: "lead", capabilities: { canManageMembers: true } }],
    });
    expect((await auditEvents(team.id)).map((row) => row.action)).toEqual(["team.created"]);

    expect((await request(`/teams/${team.id}`, "PATCH", { name: "Platform" })).status).toBe(200);
    expect((await request(`/teams/${team.id}/archive`, "POST")).status).toBe(200);
    expect((await new TeamStore(env.DB).getById(team.id))?.archivedAt).not.toBeNull();
    expect(await new TeamStore(env.DB).isActive(team.id)).toBe(false);
    expect(await (await request("/teams?membership=all")).json()).toEqual({ teams: [] });
    expect(
      await (await request("/teams?membership=all&includeArchived=true")).json()
    ).toMatchObject({
      teams: [{ id: team.id }],
    });
    expect((await request(`/teams/${team.id}/restore`, "POST")).status).toBe(200);
    expect((await new TeamStore(env.DB).getById(team.id))?.archivedAt).toBeNull();
    expect(await new TeamStore(env.DB).isActive(team.id)).toBe(true);
    expect((await auditEvents(team.id)).map((row) => row.action)).toEqual([
      "team.created",
      "team.updated",
      "team.archived",
      "team.restored",
    ]);
  });

  it("rolls back team creation if its audit write fails", async () => {
    const db = sqlDatabase(env.DB);
    const failAudit: SqlDatabase = {
      prepare(sql) {
        return sql.includes("INSERT INTO authorization_audit_events")
          ? db.prepare("INSERT INTO authorization_audit_events (id) VALUES (?)").bind("bad-audit")
          : db.prepare(sql);
      },
      batch<T>(statements: SqlStatement[]) {
        return db.batch<T>(statements);
      },
    };
    await expect(
      new TeamStore(failAudit).createWithLead(
        { slug: "rollback", name: "Rollback", joinPolicy: "invite_only" },
        OWNER,
        "audit-failure"
      )
    ).rejects.toThrow();
    expect(await new TeamStore(env.DB).getBySlug("rollback")).toBeNull();
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM team_memberships").first<{
          count: number;
        }>()
      )?.count
    ).toBe(0);
    expect((await request("/teams", "POST", { slug: "rollback", name: "Rollback" })).status).toBe(
      201
    );
  });

  it("rejects invalid default environments and reports duplicate team slugs", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "duplicate",
      name: "Existing",
      joinPolicy: "invite_only",
    });
    const duplicate = await request("/teams", "POST", { slug: "duplicate", name: "Other" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "slug_taken" });

    const other = await new TeamStore(env.DB).create({
      slug: "other",
      name: "Other",
      joinPolicy: "invite_only",
    });
    const duplicateRename = await request(`/teams/${other.id}`, "PATCH", { slug: team.slug });
    expect(duplicateRename.status).toBe(409);
    expect(await duplicateRename.json()).toMatchObject({ code: "slug_taken" });
    expect((await new TeamStore(env.DB).getById(other.id))?.slug).toBe("other");

    const invalid = await request(`/teams/${team.id}`, "PATCH", { defaultEnvironmentId: "" });
    expect(invalid.status).toBe(400);
    expect((await new TeamStore(env.DB).getById(team.id))?.defaultEnvironmentId).toBeNull();
    expect(await auditEvents(team.id)).toEqual([]);
  });

  it("lets leads manage their team without exposing another team", async () => {
    await setRole(OWNER, "member");
    const teams = new TeamStore(env.DB);
    const memberships = new TeamMembershipStore(env.DB);
    const own = await teams.create({ slug: "own", name: "Own", joinPolicy: "invite_only" });
    const other = await teams.create({ slug: "other", name: "Other", joinPolicy: "invite_only" });
    await memberships.add(own.id, OWNER, "lead");
    await memberships.add(other.id, MEMBER, "lead");
    expect((await request(`/teams/${own.id}`, "PATCH", { name: "Renamed" })).status).toBe(200);
    expect((await request(`/teams/${other.id}`, "PATCH", { name: "Forbidden" })).status).toBe(404);
    const hidden = await request(`/teams/${other.id}`);
    const absent = await request("/teams/team_missing");
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await absent.json());
    expect((await teams.getById(other.id))?.name).toBe("Other");
    const mine = await request("/teams?membership=all&search=own");
    expect(((await mine.json()) as { teams: Team[] }).teams.map((team) => team.id)).toEqual([
      own.id,
    ]);
  });

  it("rejects member creation, sole-lead demotion and departure without changing the membership", async () => {
    await setRole(OWNER, "member");
    expect((await request("/teams", "POST", { slug: "blocked", name: "Blocked" })).status).toBe(
      403
    );
    const teams = new TeamStore(env.DB);
    const memberships = new TeamMembershipStore(env.DB);
    const team = await teams.create({ slug: "lead", name: "Lead", joinPolicy: "invite_only" });
    await memberships.add(team.id, OWNER, "lead");
    const demote = await request(`/teams/${team.id}/members/${OWNER}`, "PUT", { role: "member" });
    expect(demote.status).toBe(409);
    expect(await demote.json()).toMatchObject({ code: "last_lead" });
    expect((await request(`/teams/${team.id}/members/${OWNER}`, "DELETE")).status).toBe(409);
    expect((await memberships.listForUser(OWNER)).get(team.id)).toBe("lead");
    expect(await auditEvents(team.id)).toEqual([]);
  });

  it("joins open teams, rejects invite-only joins and audits membership changes", async () => {
    await setRole(OWNER, "member");
    const teams = new TeamStore(env.DB);
    const memberships = new TeamMembershipStore(env.DB);
    const open = await teams.create({ slug: "open", name: "Open", joinPolicy: "open" });
    const closed = await teams.create({
      slug: "closed",
      name: "Closed",
      joinPolicy: "invite_only",
    });
    await memberships.add(open.id, MEMBER, "lead");
    await memberships.add(closed.id, MEMBER, "lead");
    expect((await request(`/teams/${closed.id}/join`, "POST")).status).toBe(403);
    const joined = await request(`/teams/${open.id}/join`, "POST");
    expect(joined.status).toBe(200);
    expect((await memberships.listForUser(OWNER)).get(open.id)).toBe("member");
    expect((await auditEvents(open.id)).map((row) => row.action)).toEqual(["team.member_joined"]);
    const denied = await request(`/teams/${open.id}/members/${OTHER}`, "PUT", { role: "member" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason_code: "team_capability_required" });
    expect((await request(`/teams/${open.id}/members/${OWNER}`, "DELETE")).status).toBe(204);
    expect((await auditEvents(open.id)).map((row) => row.action)).toEqual([
      "team.member_joined",
      "team.member_removed",
    ]);
  });

  it("audits adding, changing and removing members with team and target IDs", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "roles",
      name: "Roles",
      joinPolicy: "invite_only",
    });
    const store = new TeamMembershipStore(env.DB);
    await store.add(team.id, OWNER, "lead");
    expect(
      (await request(`/teams/${team.id}/members/${MEMBER}`, "PUT", { role: "member" })).status
    ).toBe(200);
    expect(
      (await request(`/teams/${team.id}/members/${MEMBER}`, "PUT", { role: "lead" })).status
    ).toBe(200);
    expect((await request(`/teams/${team.id}/members/${MEMBER}`, "DELETE")).status).toBe(204);
    const rows = await auditEvents(team.id);
    expect(rows.map((row) => row.action)).toEqual([
      "team.member_added",
      "team.member_role_changed",
      "team.member_removed",
    ]);
    for (const row of rows) {
      expect(row.team_id).toBe(team.id);
      expect(row.target_user_id_snapshot).toBe(MEMBER);
      expect(JSON.parse(String(row.metadata_json))).toMatchObject({ before: {}, after: {} });
    }
  });

  it("records a single addition when membership requests race", async () => {
    await setRole(OWNER, "member");
    const team = await new TeamStore(env.DB).create({
      slug: "concurrent",
      name: "Concurrent",
      joinPolicy: "open",
    });
    await new TeamMembershipStore(env.DB).add(team.id, MEMBER, "lead");
    const responses = await Promise.all([
      request(`/teams/${team.id}/join`, "POST"),
      request(`/teams/${team.id}/join`, "POST"),
    ]);
    expect(
      responses.map((response) => response.status).filter((status) => status === 200)
    ).toHaveLength(1);
    expect((await auditEvents(team.id)).map((row) => row.action)).toEqual(["team.member_joined"]);
  });

  it("denies a bot service even when it presents an actor", async () => {
    const result = await serviceFetch(`${BASE}/teams`, {
      service: "slack-bot",
      actor: "slack:U-TEAM",
      method: "POST",
      body: JSON.stringify({ slug: "bot", name: "Bot" }),
    });
    expect(result.status).toBe(403);
    expect(await new TeamStore(env.DB).getBySlug("bot")).toBeNull();
  });
});
