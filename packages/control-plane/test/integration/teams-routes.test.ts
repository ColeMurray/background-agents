import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import {
  meTeamsResponseSchema,
  teamSessionsResponseSchema,
  type Team,
} from "@open-inspect/shared/types/teams";
import { auditEventListResponseSchema } from "@open-inspect/shared/types/audit-events";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { SessionAuditStore } from "../../src/db/session-audit";
import { TeamAuditStore } from "../../src/db/team-audit";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamSettingsStore } from "../../src/db/team-settings";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
import { routeRequest, serviceFetch, serviceRequestHeaders, sqlDatabase } from "./helpers";
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

async function seedSession(id: string, teamId: string, overrides: Partial<SessionEntry> = {}) {
  await new SessionIndexStore(env.DB).create({
    id,
    ownerTeamId: teamId,
    visibility: "team",
    userId: MEMBER,
    title: id,
    repoOwner: "acme",
    repoName: "widgets",
    baseBranch: "main",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    status: "completed",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  });
}

function inboxPage(value: unknown) {
  const parsed = teamSessionsResponseSchema.parse(value);
  if (!("items" in parsed)) throw new Error("Expected bucket page");
  return parsed;
}

describe("team routes", () => {
  beforeEach(setupTeamRoutes);

  it.each(["", "/members", "/sessions", "/activity"])(
    "does not audit an allowed team read at /teams/:id%s",
    async (suffix) => {
      await setRole(OWNER, "member");
      const team = await new TeamStore(env.DB).create({
        slug: "quiet-read",
        name: "Quiet read",
        joinPolicy: "invite_only",
      });
      const memberships = new TeamMembershipStore(env.DB);
      await memberships.add(team.id, MEMBER, "lead");
      if (suffix === "/sessions" || suffix === "/activity") await memberships.add(team.id, OWNER);

      const response = await request(`/teams/${team.id}${suffix}`);
      expect(response.status).toBe(200);
      expect(await requestAuditEvents(response)).toEqual([]);
    }
  );

  it("audits an allowed team capability write", async () => {
    await setRole(OWNER, "member");
    const team = await new TeamStore(env.DB).create({
      slug: "audited-write",
      name: "Audited write",
      joinPolicy: "invite_only",
    });
    await new TeamMembershipStore(env.DB).add(team.id, OWNER, "lead");

    const response = await request(`/teams/${team.id}`, "PATCH", { name: "Renamed" });
    expect(response.status).toBe(200);
    expect(await requestAuditEvents(response)).toEqual([
      { action: "authorization.request_allowed" },
      { action: "team.updated" },
    ]);
  });

  it("still audits a denied team capability write", async () => {
    await setRole(OWNER, "member");
    const team = await new TeamStore(env.DB).create({
      slug: "denied-write",
      name: "Denied write",
      joinPolicy: "invite_only",
    });
    const response = await request(`/teams/${team.id}`, "PATCH", { name: "Forbidden" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason_code: "team_capability_required" });
    expect(await requestAuditEvents(response)).toEqual([
      { action: "authorization.request_denied" },
    ]);
  });

  it.each([false, true])("still audits leaving a team (archived: %s)", async (archived) => {
    await setRole(OWNER, "member");
    const team = await new TeamStore(env.DB).create({
      slug: "audited-leave",
      name: "Audited leave",
      joinPolicy: "invite_only",
    });
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(team.id, MEMBER, "lead");
    await memberships.add(team.id, OWNER);
    if (archived) await new TeamStore(env.DB).archive(team.id);

    const response = await request(`/teams/${team.id}/members/${OWNER}`, "DELETE");
    expect(response.status).toBe(204);
    expect(await requestAuditEvents(response)).toEqual([
      { action: "authorization.request_allowed" },
      { action: "team.member_removed" },
    ]);
  });

  it("starts without teams and lets an administrator create, rename, archive and restore", async () => {
    expect((await request("/me/teams")).status).toBe(200);
    expect(await (await request("/me/teams")).json()).toEqual({
      teams: [],
      requireTeamOnCreate: false,
    });
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

  it("meTeams exposes the creation setting to active users without settings permissions", async () => {
    await setRole(OWNER, "member");
    const settings = new TeamSettingsStore(env.DB);
    for (const requireTeamOnCreate of [false, true, false]) {
      await settings.set({ requireTeamOnCreate });
      const response = await request("/me/teams");
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(meTeamsResponseSchema.parse(await response.json())).toEqual({
        teams: [],
        requireTeamOnCreate,
      });
    }
  });

  it("meTeams still requires an active human user", async () => {
    const bot = await serviceFetch(`${BASE}/me/teams`, { service: "slack-bot" });
    expect(bot.status).toBe(403);
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(Date.now(), OWNER)
      .run();
    expect((await request("/me/teams")).status).toBe(403);
  });

  it("reports member counts on list, membership and detail responses", async () => {
    const created = await request("/teams", "POST", { slug: "counted", name: "Counted" });
    const team = (await created.json()) as Team;
    await new TeamMembershipStore(env.DB).add(team.id, MEMBER);
    const other = await request("/teams", "POST", { slug: "second", name: "Second" });
    const second = (await other.json()) as Team;

    expect(await (await request("/teams?membership=all")).json()).toMatchObject({
      teams: [
        { id: team.id, memberCount: 2 },
        { id: second.id, memberCount: 1 },
      ],
    });
    expect(await (await request("/me/teams")).json()).toMatchObject({
      teams: [
        { id: team.id, memberCount: 2 },
        { id: second.id, memberCount: 1 },
      ],
    });
    expect(await (await request(`/teams/${team.id}`)).json()).toMatchObject({ memberCount: 2 });
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

  it("lets leads manage their team and reads other teams without granting management", async () => {
    await setRole(OWNER, "member");
    const teams = new TeamStore(env.DB);
    const memberships = new TeamMembershipStore(env.DB);
    const own = await teams.create({ slug: "own", name: "Own", joinPolicy: "invite_only" });
    const other = await teams.create({ slug: "other", name: "Other", joinPolicy: "invite_only" });
    await memberships.add(own.id, OWNER, "lead");
    await memberships.add(other.id, MEMBER, "lead");
    expect((await request(`/teams/${own.id}`, "PATCH", { name: "Renamed" })).status).toBe(200);
    const denied = await request(`/teams/${other.id}`, "PATCH", { name: "Forbidden" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason_code: "team_capability_required" });
    expect((await request(`/teams/${other.id}`)).status).toBe(200);
    const absent = await request("/teams/team_missing");
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: "Team not found" });
    expect((await teams.getById(other.id))?.name).toBe("Other");
    const mine = await request("/teams?membership=all&search=own");
    expect(((await mine.json()) as { teams: Team[] }).teams.map((team) => team.id)).toEqual([
      own.id,
    ]);
  });

  it.each(["member", "viewer"] as const)(
    "lists all active teams and their members for a nonmember %s",
    async (role) => {
      await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
        .bind(BUILT_IN_ROLE_REGISTRY[role].id, OWNER)
        .run();
      const teams = new TeamStore(env.DB);
      const open = await teams.create({ slug: "directory-open", name: "Open", joinPolicy: "open" });
      const closed = await teams.create({
        slug: "directory-closed",
        name: "Closed",
        joinPolicy: "invite_only",
      });
      const archived = await teams.create({
        slug: "directory-archived",
        name: "Archived",
        joinPolicy: "open",
      });
      await teams.archive(archived.id);
      await new TeamMembershipStore(env.DB).add(open.id, MEMBER, "lead");
      const all = await (
        await request("/teams?membership=all")
      ).json<{ teams: Array<{ id: string; memberCount: number }> }>();
      expect(all.teams.map(({ id }) => id).sort()).toEqual([open.id, closed.id].sort());
      expect(all.teams.find(({ id }) => id === open.id)?.memberCount).toBe(1);
      expect(await (await request("/teams?membership=mine")).json()).toEqual({ teams: [] });
      expect(await (await request(`/teams/${open.id}`)).json()).toMatchObject({
        id: open.id,
        capabilities: { canJoin: true, canManageMembers: false },
      });
      expect(await (await request(`/teams/${open.id}/members`)).json()).toMatchObject({
        members: [{ userId: MEMBER, role: "lead" }],
      });
      expect((await request(`/teams/${closed.id}`)).status).toBe(200);
      expect((await request(`/teams/${open.id}/members/${MEMBER}`, "DELETE")).status).toBe(404);
      const manage = await request(`/teams/${open.id}/members/${OTHER}`, "PUT", { role: "member" });
      expect(manage.status).toBe(403);
      expect(await manage.json()).toMatchObject({ reason_code: "team_capability_required" });
      expect((await request(`/teams/${open.id}/join`, "POST")).status).toBe(200);
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "always conceals member-only tabs from nonmembers in %s",
    async (mode) => {
      await setRole(OWNER, "member");
      const team = await new TeamStore(env.DB).create({
        slug: "guarded",
        name: "Guarded",
        joinPolicy: "open",
      });
      for (const tab of ["sessions", "activity"]) {
        const hidden = await modeRequest(`/teams/${team.id}/${tab}`, mode);
        const missing = await modeRequest(`/teams/team_missing/${tab}`, mode);
        expect(hidden.status, tab).toBe(404);
        expect(await hidden.json(), tab).toEqual(await missing.json());
        const bot = await serviceFetch(`${BASE}/teams/${team.id}/${tab}`, {
          service: "slack-bot",
          actor: "slack:U-TEAM",
        });
        expect(bot.status).toBe(403);
      }
    }
  );

  describe("archived directory access", () => {
    it.each(["off", "shadow", "on"] as const)(
      "lists active teams and only the caller's archived memberships in %s",
      async (mode) => {
        const teams = new TeamStore(env.DB);
        const active = await teams.create({ slug: "active", name: "Active", joinPolicy: "open" });
        const own = await teams.create({ slug: "own-archived", name: "Own", joinPolicy: "open" });
        const other = await teams.create({
          slug: "other-archived",
          name: "Other",
          joinPolicy: "open",
        });
        await new TeamMembershipStore(env.DB).add(own.id, OWNER, "lead");
        await teams.archive(own.id);
        await teams.archive(other.id);

        for (const role of ["member", "viewer"] as const) {
          await setRole(OWNER, role);
          const all = await modeRequest("/teams?membership=all&includeArchived=true", mode, role);
          expect(all.status).toBe(200);
          const result = await all.json<{ teams: Team[] }>();
          expect(result.teams.map(({ id }) => id).sort()).toEqual([active.id, own.id].sort());
          expect(
            await (
              await modeRequest(
                "/teams?membership=all&includeArchived=true&search=other",
                mode,
                role
              )
            ).json()
          ).toEqual({ teams: [] });
          expect(
            await (await modeRequest("/teams?membership=all", mode, role)).json()
          ).toMatchObject({ teams: [{ id: active.id }] });
          expect(
            await (
              await modeRequest("/teams?membership=mine&includeArchived=true", mode, role)
            ).json()
          ).toMatchObject({ teams: [{ id: own.id }] });
          const mine = await (
            await modeRequest("/me/teams", mode, role)
          ).json<{ teams: Array<Team & { role: string }> }>();
          expect(mine.teams).toHaveLength(1);
          expect(mine.teams[0]).toMatchObject({ id: own.id, role: "lead" });
          expect(mine.teams[0].archivedAt).not.toBeNull();
        }
      }
    );

    it.each(["off", "shadow", "on"] as const)(
      "conceals archived detail and member reads with the missing-team 404 in %s",
      async (mode) => {
        const teams = new TeamStore(env.DB);
        const archived = await teams.create({
          slug: "hidden-archived",
          name: "Hidden",
          joinPolicy: "open",
        });
        await new TeamMembershipStore(env.DB).add(archived.id, MEMBER, "lead");
        await teams.archive(archived.id);

        for (const role of ["member", "viewer"] as const) {
          await setRole(OWNER, role);
          for (const suffix of ["", "/members"]) {
            const hidden = await modeRequest(`/teams/${archived.id}${suffix}`, mode, role);
            const missing = await modeRequest(`/teams/team_missing${suffix}`, mode, role);
            expect(hidden.status, `${role}${suffix}`).toBe(404);
            expect(missing.status).toBe(404);
            expect(await hidden.json()).toEqual(await missing.json());
          }
        }
      }
    );

    it.each([
      { role: "member", teamRole: "member", canRestore: false },
      { role: "member", teamRole: "lead", canRestore: true },
      { role: "owner", teamRole: null, canRestore: true },
      { role: "administrator", teamRole: null, canRestore: true },
    ] as const)(
      "preserves archived reads and restore capabilities for $role / $teamRole",
      async ({ role, teamRole, canRestore }) => {
        await setRole(OWNER, role);
        const teams = new TeamStore(env.DB);
        const archived = await teams.create({
          slug: "readable-archived",
          name: "Readable",
          joinPolicy: "invite_only",
        });
        const memberships = new TeamMembershipStore(env.DB);
        await memberships.add(archived.id, MEMBER, "lead");
        if (teamRole) await memberships.add(archived.id, OWNER, teamRole);
        await teams.archive(archived.id);

        const detail = await request(`/teams/${archived.id}`);
        expect(detail.status).toBe(200);
        expect(await detail.json()).toMatchObject({
          id: archived.id,
          capabilities: { canArchive: canRestore },
        });
        const members = await request(`/teams/${archived.id}/members`);
        expect(members.status).toBe(200);
        expect(await members.json()).toMatchObject({
          members: expect.arrayContaining([
            expect.objectContaining({ userId: MEMBER, role: "lead" }),
          ]),
        });
        const all = await request("/teams?membership=all&includeArchived=true");
        expect(await all.json()).toMatchObject({ teams: [{ id: archived.id }] });
        expect((await request(`/teams/${archived.id}/restore`, "POST")).status).toBe(
          canRestore ? 200 : 403
        );
        expect((await teams.getById(archived.id))?.archivedAt === null).toBe(canRestore);
      }
    );
  });

  it.each(["off", "shadow", "on"] as const)(
    "returns scoped inbox buckets with effective capabilities and never lists unshared private rows in %s",
    async (mode) => {
      await setRole(OWNER, "member");
      const teams = new TeamStore(env.DB);
      const team = await teams.create({ slug: "inbox", name: "Inbox", joinPolicy: "open" });
      const other = await teams.create({
        slug: "elsewhere",
        name: "Elsewhere",
        joinPolicy: "open",
      });
      await new TeamMembershipStore(env.DB).add(team.id, OWNER);
      await seedSession("finished", team.id);
      await seedSession("active", team.id, { status: "active" });
      await seedSession("attention", team.id);
      await new SessionIndexStore(env.DB).recordLatestTerminalMessage({
        sessionId: "attention",
        messageId: "reply",
        messageCreatedAt: Date.now() + 1000,
        terminalMessageCompletedAt: Date.now() + 1000,
      });
      await seedSession("hidden-private", team.id, { visibility: "private", status: "active" });
      await seedSession("shared-private", team.id, { visibility: "private" });
      await new SessionCollaboratorStore(env.DB).add("shared-private", OWNER, MEMBER);
      await seedSession("other-team", other.id, { visibility: "workspace" });
      const response = await modeRequest(`/teams/${team.id}/sessions`, mode);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const snapshot = teamSessionsResponseSchema.parse(await response.json());
      if (!("categories" in snapshot)) throw new Error("Expected bucket snapshot");
      expect(
        snapshot.categories.needs_attention.items.map(({ rootSession }) => rootSession.id)
      ).toEqual(["attention"]);
      expect(
        snapshot.categories.in_progress.items.map(({ rootSession }) => rootSession.id)
      ).toEqual(["active"]);
      expect(
        snapshot.categories.finished.items.map(({ rootSession }) => rootSession.id).sort()
      ).toEqual(["finished", "shared-private"]);
      expect(
        snapshot.categories.finished.items.find(({ rootSession }) => rootSession.id === "finished")
          ?.rootSession
      ).toMatchObject({
        ownerTeamId: team.id,
        visibility: "team",
        capabilities: { canRead: true, canDelete: mode !== "on", canMove: false },
      });
      const page = inboxPage(
        await (
          await modeRequest(
            `/teams/${team.id}/sessions?bucket=finished&teamIds[]=${other.id}`,
            mode
          )
        ).json()
      );
      expect(page.items.map(({ rootSession }) => rootSession.id).sort()).toEqual([
        "finished",
        "shared-private",
      ]);
      expect(
        page.items.find(({ rootSession }) => rootSession.id === "shared-private")?.rootSession
          .capabilities
      ).toMatchObject({
        canRead: true,
        canManageCollaborators: false,
        canMove: false,
      });
    }
  );

  it("paginates session buckets, decorates descendants, and rejects malformed inbox queries", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "paged",
      name: "Paged",
      joinPolicy: "open",
    });
    for (let index = 0; index < 21; index++)
      await seedSession(`paged-${String(index).padStart(2, "0")}`, team.id);
    await seedSession("child", team.id, {
      parentSessionId: "paged-20",
      spawnDepth: 1,
      spawnSource: "agent",
    });
    const firstResponse = await modeRequest(
      `/teams/${team.id}/sessions?bucket=finished`,
      "on",
      "owner"
    );
    expect(firstResponse.status).toBe(200);
    const first = inboxPage(await firstResponse.json());
    expect(first.items).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.items[0].descendantSessions[0]).toMatchObject({
      id: "child",
      capabilities: { canRead: true },
    });
    const second = inboxPage(
      await (
        await modeRequest(
          `/teams/${team.id}/sessions?bucket=finished&cursor=${first.nextCursor}`,
          "on",
          "owner"
        )
      ).json()
    );
    expect(second).toMatchObject({
      items: [{ rootSession: { id: "paged-00" } }],
      hasMore: false,
      nextCursor: null,
    });
    for (const query of [
      "bucket=invalid",
      "bucket=finished&bucket=in_progress",
      "cursor=bad",
      "bucket=finished&cursor=bad",
      "bucket=finished&cursor=",
    ]) {
      expect(
        (await modeRequest(`/teams/${team.id}/sessions?${query}`, "on", "owner")).status,
        query
      ).toBe(400);
    }
  });

  it.each(["viewer", "administrator", "owner"] as const)(
    "returns effective %s capabilities without administrative private-session list access",
    async (role) => {
      await setRole(OWNER, role);
      const team = await new TeamStore(env.DB).create({
        slug: "role-inbox",
        name: "Role Inbox",
        joinPolicy: "open",
      });
      if (role === "viewer") await new TeamMembershipStore(env.DB).add(team.id, OWNER);
      await seedSession("role-visible", team.id);
      await seedSession("role-private", team.id, { visibility: "private" });
      const response = await modeRequest(`/teams/${team.id}/sessions?bucket=finished`, "on", role);
      expect(response.status).toBe(200);
      const page = inboxPage(await response.json());
      expect(page.items).toHaveLength(1);
      expect(page.items[0].rootSession).toMatchObject({
        id: "role-visible",
        capabilities: {
          canRead: true,
          canCollaborate: role !== "viewer",
          canManageLifecycle: role !== "viewer",
          canDelete: role !== "viewer",
          canMove: role !== "viewer",
          canSandbox: role !== "viewer",
          canManageCollaborators: role === "owner",
          canChangeVisibility: role !== "viewer",
        },
      });
      expect(JSON.stringify(page)).not.toContain("role-private");
      expect(page.items[0].rootSession).not.toHaveProperty("userId");
    }
  );

  it("omits inaccessible ancestor IDs when a visible child is rerooted into the team inbox", async () => {
    await setRole(OWNER, "member");
    const team = await new TeamStore(env.DB).create({
      slug: "rerooted",
      name: "Rerooted",
      joinPolicy: "open",
    });
    await new TeamMembershipStore(env.DB).add(team.id, OWNER);
    await seedSession("private-ancestor", team.id, { visibility: "private" });
    await seedSession("visible-child", team.id, {
      parentSessionId: "private-ancestor",
      visibility: "workspace",
      spawnDepth: 1,
      spawnSource: "agent",
    });
    const response = await modeRequest(`/teams/${team.id}/sessions?bucket=finished`, "on");
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("private-ancestor");
    expect(body).toMatchObject({
      items: [{ rootSession: { id: "visible-child", parentSessionId: null } }],
    });
  });

  it("denies directory and member-only reads for suspended and role-less users", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "inactive",
      name: "Inactive",
      joinPolicy: "open",
    });
    await new TeamMembershipStore(env.DB).add(team.id, OWNER);
    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(OWNER).run();
    for (const path of [
      "/teams?membership=all",
      `/teams/${team.id}`,
      `/teams/${team.id}/members`,
      `/teams/${team.id}/sessions`,
      `/teams/${team.id}/activity`,
    ]) {
      expect((await request(path)).status, path).toBe(403);
    }
    await env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").bind(OWNER).run();
    await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(OWNER).run();
    expect((await request("/teams?membership=all")).status).toBe(403);
    expect((await request(`/teams/${team.id}/activity`)).status).toBe(403);
  });

  it("allows directory reads without session permissions but keeps session data inaccessible", async () => {
    await env.DB.prepare(
      "INSERT INTO roles (id, key, name, normalized_name, is_system) VALUES ('role_directory', NULL, 'Directory', 'directory', 0)"
    ).run();
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_directory' WHERE user_id = ?"
    )
      .bind(OWNER)
      .run();
    const team = await new TeamStore(env.DB).create({
      slug: "directory-only",
      name: "Directory",
      joinPolicy: "open",
    });
    await new TeamMembershipStore(env.DB).add(team.id, OWNER);
    await seedSession("not-readable", team.id, { visibility: "workspace" });
    await new SessionAuditStore(env.DB).write({
      requestId: "no-read",
      actorUserId: MEMBER,
      action: "session.visibility_changed",
      sessionId: "not-readable",
      teamId: team.id,
      before: {},
      after: {},
    });
    await new TeamAuditStore(env.DB).write({
      requestId: "directory-event",
      actorUserId: MEMBER,
      action: "team.updated",
      teamId: team.id,
      before: {},
      after: {},
    });
    expect((await request("/teams?membership=all")).status).toBe(200);
    expect((await request(`/teams/${team.id}`)).status).toBe(200);
    expect((await request(`/teams/${team.id}/sessions`)).status).toBe(403);
    const feed = auditEventListResponseSchema.parse(
      await (await request(`/teams/${team.id}/activity`)).json()
    );
    expect(feed.events.map(({ action }) => action)).toEqual(["team.updated"]);
  });

  it.each(["off", "shadow", "on"] as const)(
    "serves a visibility-filtered, action-filtered team audit feed without workspace audit permission in %s",
    async (mode) => {
      await setRole(OWNER, "member");
      const team = await new TeamStore(env.DB).create({
        slug: "feed",
        name: "Feed",
        joinPolicy: "open",
      });
      await new TeamMembershipStore(env.DB).add(team.id, OWNER);
      await seedSession("visible", team.id);
      await seedSession("secret-title", team.id, { visibility: "private" });
      const audit = new SessionAuditStore(env.DB);
      for (const sessionId of ["visible", "secret-title", "deleted-private"]) {
        await audit.write({
          requestId: `request-${sessionId}`,
          actorUserId: MEMBER,
          action: "session.visibility_changed",
          sessionId,
          teamId: team.id,
          before: { title: sessionId },
          after: { visibility: "private" },
        });
      }
      await new TeamAuditStore(env.DB).write({
        requestId: "team-event",
        actorUserId: MEMBER,
        action: "team.updated",
        teamId: team.id,
        before: {},
        after: { name: "Feed" },
      });
      const response = await modeRequest(`/teams/${team.id}/activity?limit=1`, mode);
      expect(response.status).toBe(200);
      const first = auditEventListResponseSchema.parse(await response.json());
      expect(first).toMatchObject({ events: [{ action: "team.updated" }], hasMore: true });
      const second = auditEventListResponseSchema.parse(
        await (
          await modeRequest(`/teams/${team.id}/activity?limit=1&cursor=${first.nextCursor}`, mode)
        ).json()
      );
      expect(second).toMatchObject({
        events: [{ resourceId: "visible" }],
        hasMore: false,
        nextCursor: null,
      });
      expect(JSON.stringify(first) + JSON.stringify(second)).not.toContain("secret-title");
      const filtered = auditEventListResponseSchema.parse(
        await (
          await modeRequest(`/teams/${team.id}/activity?action=session.visibility_changed`, mode)
        ).json()
      );
      expect(filtered.events.map(({ resourceId }) => resourceId)).toEqual(["visible"]);
      await new SessionCollaboratorStore(env.DB).add("secret-title", OWNER, MEMBER);
      const shared = auditEventListResponseSchema.parse(
        await (
          await modeRequest(`/teams/${team.id}/activity?action=session.visibility_changed`, mode)
        ).json()
      );
      expect(shared.events.map(({ resourceId }) => resourceId).sort()).toEqual([
        "secret-title",
        "visible",
      ]);
      for (const query of [
        "limit=0",
        "limit=101",
        "cursor=bad",
        "action=",
        "action=one&action=two",
      ]) {
        expect((await modeRequest(`/teams/${team.id}/activity?${query}`, mode)).status, query).toBe(
          400
        );
      }
    }
  );

  it.each([false, true])(
    "rejects sole-lead demotion and departure without changing membership (archived: %s)",
    async (archived) => {
      await setRole(OWNER, "member");
      expect((await request("/teams", "POST", { slug: "blocked", name: "Blocked" })).status).toBe(
        403
      );
      const teams = new TeamStore(env.DB);
      const memberships = new TeamMembershipStore(env.DB);
      const team = await teams.create({ slug: "lead", name: "Lead", joinPolicy: "invite_only" });
      await memberships.add(team.id, OWNER, "lead");
      if (archived) await teams.archive(team.id);
      const demote = await request(`/teams/${team.id}/members/${OWNER}`, "PUT", { role: "member" });
      expect(demote.status).toBe(409);
      expect(await demote.json()).toMatchObject({ code: "last_lead" });
      const leave = await request(`/teams/${team.id}/members/${OWNER}`, "DELETE");
      expect(leave.status).toBe(409);
      expect(await leave.json()).toMatchObject({ code: "last_lead" });
      expect(await requestAuditEvents(leave)).toEqual([
        { action: "authorization.request_allowed" },
      ]);
      expect((await memberships.listForUser(OWNER)).get(team.id)).toBe("lead");
      expect(await auditEvents(team.id)).toEqual([]);
    }
  );

  it("moves a session with its children and immediately updates both team buckets", async () => {
    await setRole(OWNER, "member");
    const teams = new TeamStore(env.DB);
    const source = await teams.create({ slug: "source", name: "Source", joinPolicy: "open" });
    const target = await teams.create({ slug: "target", name: "Target", joinPolicy: "open" });
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(source.id, OWNER);
    await memberships.add(target.id, OWNER);
    const owned = { userId: OWNER, repoOwner: null, repoName: null, baseBranch: null };
    await seedSession("move-parent", source.id, owned);
    await seedSession("move-child", source.id, { ...owned, parentSessionId: "move-parent" });
    const bucket = (teamId: string) => request(`/teams/${teamId}/sessions?bucket=finished`);
    expect(
      inboxPage(await (await bucket(source.id)).json()).items[0].descendantSessions
    ).toHaveLength(1);
    expect(inboxPage(await (await bucket(target.id)).json()).items).toEqual([]);
    const moved = await request("/sessions/move-parent/scope", "PUT", {
      teamId: target.id,
      includeChildren: true,
    });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ affectedSessionIds: ["move-parent", "move-child"] });
    expect(inboxPage(await (await bucket(source.id)).json()).items).toEqual([]);
    expect(inboxPage(await (await bucket(target.id)).json()).items).toMatchObject([
      {
        rootSession: { id: "move-parent", ownerTeamId: target.id, updatedAt: 100 },
        descendantSessions: [{ id: "move-child", ownerTeamId: target.id, updatedAt: 100 }],
      },
    ]);
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

  it.each(["off", "shadow", "on"] as const)(
    "preserves the reason for every unavailable join in %s",
    async (mode) => {
      await setRole(OWNER, "member");
      const teams = new TeamStore(env.DB);
      const memberships = new TeamMembershipStore(env.DB);
      const closed = await teams.create({
        slug: "join-closed",
        name: "Closed",
        joinPolicy: "invite_only",
      });
      const archived = await teams.create({
        slug: "join-archived",
        name: "Archived",
        joinPolicy: "open",
      });
      await teams.archive(archived.id);
      const joined = await teams.create({
        slug: "join-existing",
        name: "Joined",
        joinPolicy: "open",
      });
      await memberships.add(joined.id, OWNER);
      for (const { team, reason } of [
        { team: closed, reason: "invite_only" },
        { team: archived, reason: "team_archived" },
        { team: joined, reason: "already_member" },
      ]) {
        const url = `${BASE}/teams/${team.id}/join`;
        const headers = await serviceRequestHeaders(url, {
          method: "POST",
          as: { userId: OWNER, role: "member" },
        });
        const denied = await routeRequest(
          new Request(url, { method: "POST", headers }),
          { ...env, TEAMS_ENFORCEMENT: mode },
          createExecutionContext()
        );
        expect(denied.status, team.slug).toBe(403);
        expect(await denied.json(), team.slug).toEqual({
          error: "Forbidden",
          code: reason,
          reason_code: reason,
        });
        expect(await auditEvents(team.id)).toEqual([]);
      }
      expect((await memberships.listForUser(OWNER)).get(joined.id)).toBe("member");
      expect((await memberships.listForUser(OWNER)).has(closed.id)).toBe(false);
      expect((await memberships.listForUser(OWNER)).has(archived.id)).toBe(false);
    }
  );

  it.each([false, true])(
    "denies and audits ordinary-member removal of another member (archived: %s)",
    async (archived) => {
      await setRole(OWNER, "member");
      const team = await new TeamStore(env.DB).create({
        slug: "remove-guard",
        name: "Remove Guard",
        joinPolicy: "open",
      });
      const memberships = new TeamMembershipStore(env.DB);
      await memberships.add(team.id, OWNER);
      await memberships.add(team.id, MEMBER, "lead");
      if (archived) await new TeamStore(env.DB).archive(team.id);
      const absent = await request(`/teams/${team.id}/members/${OTHER}`, "DELETE");
      expect(absent.status).toBe(404);
      expect(await absent.json()).toEqual({ error: "Team membership not found" });
      const denied = await request(`/teams/${team.id}/members/${MEMBER}`, "DELETE");
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ reason_code: "team_capability_required" });
      expect((await memberships.listForUser(MEMBER)).get(team.id)).toBe("lead");
      expect(await auditEvents(team.id)).toEqual([]);
      expect(await requestAuditEvents(denied)).toEqual([
        { action: "authorization.request_denied" },
      ]);
    }
  );

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
