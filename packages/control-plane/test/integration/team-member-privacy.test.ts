import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { teamMemberSchema } from "@open-inspect/shared/types/teams";
import { auditEventListResponseSchema } from "@open-inspect/shared/types/audit-events";
import { TeamAuditStore } from "../../src/db/team-audit";
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
  modeRequest,
  setupTeamRoutes,
} from "./team-route-helpers";

describe("team member privacy", () => {
  beforeEach(setupTeamRoutes);

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

  it("audits administrator membership changes without profile fields for a different member reading activity", async () => {
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

    const response = await serviceFetch(`${BASE}/teams/${team.id}/activity`, {
      as: { userId: OTHER, role: "member" },
    });
    expect(response.status).toBe(200);
    const feed = auditEventListResponseSchema.parse(await response.json());
    expect(feed.hasMore).toBe(false);
    expect(feed.events.map(({ action, metadata }) => ({ action, metadata }))).toEqual(
      [...expectedEvents].reverse()
    );
    for (const event of feed.events) {
      expect(event.actorUserIdSnapshot).toBe(OWNER);
      expect(event.targetUserIdSnapshot).toBe(MEMBER);
    }
  });

  it.each(["off", "shadow", "on"] as const)(
    "redacts historical membership audit emails in activity only without member read permission in %s",
    async (mode) => {
      const team = await new TeamStore(env.DB).create({
        slug: "historical-email",
        name: "Historical email",
        joinPolicy: "invite_only",
      });
      await new TeamMembershipStore(env.DB).add(team.id, OWNER);
      const member = {
        teamId: team.id,
        userId: MEMBER,
        role: "member",
        source: "manual",
        createdAt: 1,
        displayName: "Ada",
        email: "historical@example.com",
        avatarUrl: "https://example.com/ada.png",
      };
      const audit = new TeamAuditStore(env.DB);
      const actions = [
        "team.member_added",
        "team.member_role_changed",
        "team.member_removed",
      ] as const;
      for (const action of actions) {
        await audit.write({
          requestId: action,
          actorUserId: OTHER,
          teamId: team.id,
          targetUserId: MEMBER,
          action,
          before: action === "team.member_added" ? {} : member,
          after: action === "team.member_removed" ? {} : { ...member, role: "lead" },
        });
      }
      for (const role of ["member", "administrator"] as const) {
        await setRole(OWNER, role);
        for (const action of actions) {
          const response = await modeRequest(
            `/teams/${team.id}/activity?action=${action}`,
            mode,
            role
          );
          expect(response.status).toBe(200);
          const feed = auditEventListResponseSchema.parse(await response.json());
          expect(feed.events).toHaveLength(1);
          expect(feed.events[0].metadata).toEqual({
            before:
              action === "team.member_added"
                ? {}
                : { ...member, email: role === "administrator" ? member.email : null },
            requested: {},
            after:
              action === "team.member_removed"
                ? {}
                : {
                    ...member,
                    role: "lead",
                    email: role === "administrator" ? member.email : null,
                  },
          });
          if (role === "member") expect(JSON.stringify(feed)).not.toContain(member.email);
        }
      }
      const rows = await auditEvents(team.id);
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(String(row.metadata_json)).toContain(member.email);
    }
  );
});
