import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { teamMemberSchema } from "@open-inspect/shared/types/teams";
import { auditEventListResponseSchema } from "@open-inspect/shared/types/audit-events";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { serviceFetch } from "./helpers";
import {
  BASE,
  OWNER,
  MEMBER,
  OTHER,
  request,
  setRole,
  auditEvents,
  requestAuditEvents,
  modeRequest,
  setupTeamRoutes,
} from "./team-route-helpers";

describe("team member privacy", () => {
  beforeEach(setupTeamRoutes);

  it.each(["off", "shadow", "on"] as const)(
    "does not expose team activity to members or administrators in %s mode",
    async (mode) => {
      const team = await new TeamStore(env.DB).create({
        slug: "no-activity",
        name: "No activity",
        joinPolicy: "invite_only",
      });
      await new TeamMembershipStore(env.DB).add(team.id, OWNER);
      for (const role of ["member", "administrator", "owner"] as const) {
        await setRole(OWNER, role);
        expect((await modeRequest(`/teams/${team.id}/activity`, mode, role)).status).toBe(404);
      }
    }
  );

  it.each([
    ["member", "lead", false],
    ["member", "lead", true],
    ["administrator", null, false],
    ["administrator", null, true],
  ] as const)(
    "admits and audits cross-target removal for %s/%s (archived: %s)",
    async (role, teamRole, archived) => {
      await setRole(OWNER, role);
      const teams = new TeamStore(env.DB);
      const team = await teams.create({
        slug: "managed-removal",
        name: "Managed removal",
        joinPolicy: "open",
      });
      const memberships = new TeamMembershipStore(env.DB);
      await memberships.add(team.id, MEMBER, "lead");
      await memberships.add(team.id, OTHER);
      if (teamRole) await memberships.add(team.id, OWNER, teamRole);
      if (archived) await teams.archive(team.id);

      const response = await request(`/teams/${team.id}/members/${OTHER}`, "DELETE");
      expect(response.status).toBe(204);
      expect((await memberships.listForUser(OTHER)).has(team.id)).toBe(false);
      expect(await requestAuditEvents(response)).toEqual([
        { action: "authorization.request_allowed" },
        { action: "team.member_removed" },
      ]);
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "returns directory emails only with workspace member read permission in %s mode",
    async (mode) => {
      const team = await new TeamStore(env.DB).create({
        slug: "email-directory",
        name: "Email directory",
        joinPolicy: "open",
      });
      const memberships = new TeamMembershipStore(env.DB);
      for (const userId of [MEMBER, OTHER]) {
        await env.DB.prepare(
          "UPDATE users SET display_name = ?, email = ?, avatar_url = ? WHERE id = ?"
        )
          .bind("Team member", `${userId}@example.com`, "https://example.com/avatar.png", userId)
          .run();
        await memberships.add(team.id, userId);
      }
      for (const role of ["member", "administrator"] as const) {
        await setRole(OWNER, role);
        const response = await modeRequest(`/teams/${team.id}/members`, mode, role);
        expect(response.status).toBe(200);
        const body = await response.json<{ members: unknown[] }>();
        const members = teamMemberSchema.array().parse(body.members);
        expect(members).toHaveLength(2);
        for (const member of members) {
          expect(member).toMatchObject({
            displayName: "Team member",
            email: role === "administrator" ? `${member.userId}@example.com` : null,
            avatarUrl: "https://example.com/avatar.png",
          });
        }
      }
    }
  );

  it("redacts member emails for a non-administrator lead on add, role change, and unchanged role", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "email-lead",
      name: "Email lead",
      joinPolicy: "invite_only",
    });
    await new TeamMembershipStore(env.DB).add(team.id, OWNER, "lead");
    await setRole(OWNER, "member");
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
      .bind("member@example.com", MEMBER)
      .run();
    for (const role of ["member", "lead", "lead"] as const) {
      const response = await request(`/teams/${team.id}/members/${MEMBER}`, "PUT", { role });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        member: { userId: MEMBER, role, email: null },
      });
    }
    await setRole(OWNER, "administrator");
    const response = await request(`/teams/${team.id}/members/${MEMBER}`, "PUT", {
      role: "member",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      member: { userId: MEMBER, email: "member@example.com" },
    });
  });

  it("denies member audit reads and exposes administrator membership audit metadata without profile fields", async () => {
    await setRole(OWNER, "administrator");
    await setRole(OTHER, "member");
    await env.DB.prepare(
      "UPDATE users SET display_name = ?, email = ?, avatar_url = ? WHERE id = ?"
    )
      .bind("Ada", "ada@example.com", "https://example.com/ada.png", MEMBER)
      .run();
    const team = await new TeamStore(env.DB).create({
      slug: "roles",
      name: "Roles",
      joinPolicy: "invite_only",
    });
    const store = new TeamMembershipStore(env.DB);
    await store.add(team.id, OWNER, "lead");
    await store.add(team.id, OTHER);
    const addedResponse = await request(`/teams/${team.id}/members/${MEMBER}`, "PUT", {
      role: "member",
    });
    expect(addedResponse.status).toBe(200);
    const added = teamMemberSchema.parse((await addedResponse.json<{ member: unknown }>()).member);
    expect(added).toMatchObject({
      userId: MEMBER,
      role: "member",
      displayName: "Ada",
      email: "ada@example.com",
      avatarUrl: "https://example.com/ada.png",
    });
    const changedResponse = await request(`/teams/${team.id}/members/${MEMBER}`, "PUT", {
      role: "lead",
    });
    expect(changedResponse.status).toBe(200);
    expect(await changedResponse.json()).toMatchObject({
      member: { userId: MEMBER, role: "lead", email: "ada@example.com" },
    });
    expect((await request(`/teams/${team.id}/members/${MEMBER}`, "DELETE")).status).toBe(204);
    const member = {
      teamId: team.id,
      userId: MEMBER,
      role: "member",
      source: "manual",
      createdAt: added.createdAt,
    };
    const lead = { ...member, role: "lead" };
    const expectedEvents = [
      {
        action: "team.member_added",
        metadata: { before: {}, requested: {}, after: member },
      },
      {
        action: "team.member_role_changed",
        metadata: { before: member, requested: {}, after: lead },
      },
      {
        action: "team.member_removed",
        metadata: { before: lead, requested: {}, after: {} },
      },
    ];
    const rows = await auditEvents(team.id);
    expect(
      rows.map((row) => ({
        action: row.action,
        metadata: JSON.parse(String(row.metadata_json)),
      }))
    ).toEqual(expectedEvents);
    for (const row of rows) {
      expect(row.team_id).toBe(team.id);
      expect(row.target_user_id_snapshot).toBe(MEMBER);
    }

    const denied = await serviceFetch(`${BASE}/audit-events?teamId=${team.id}`, {
      as: { userId: OTHER, role: "member" },
    });
    expect(denied.status).toBe(403);
    const response = await request(`/audit-events?teamId=${team.id}`);
    expect(response.status).toBe(200);
    const feed = auditEventListResponseSchema.parse(await response.json());
    expect(feed.hasMore).toBe(false);
    const domainEvents = feed.events.filter(({ resourceType }) => resourceType !== "http_route");
    expect(domainEvents.map(({ action, metadata }) => ({ action, metadata }))).toEqual(
      [...expectedEvents].reverse()
    );
    for (const event of domainEvents) {
      expect(event.actorUserIdSnapshot).toBe(OWNER);
      expect(event.targetUserIdSnapshot).toBe(MEMBER);
    }
  });
});
