import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TeamStore, DefaultTeamImmutableError } from "../../src/db/teams";
import { TeamMembershipStore, LastLeadError } from "../../src/db/team-memberships";
import { cleanD1Tables } from "./cleanup";
import { sqlDatabase } from "./helpers";

beforeEach(cleanD1Tables);

describe("team and membership stores", () => {
  it("validates team rows and refuses to archive or restore the default team", async () => {
    const store = new TeamStore(env.DB);
    expect((await store.getDefault()).slug).toBe("default");
    await expect(store.archive("team_default")).rejects.toBeInstanceOf(DefaultTeamImmutableError);
    await expect(store.restore("team_default")).rejects.toBeInstanceOf(DefaultTeamImmutableError);
    const created = await store.create({
      slug: "eng",
      name: "Engineering",
      joinPolicy: "invite_only",
    });
    expect(created.id).toMatch(/^team_/);
    expect(await store.getBySlug("eng")).toEqual(created);
    expect((await store.list({ includeArchived: true })).map((team) => team.id)).toContain(
      created.id
    );
    expect(await store.archive(created.id)).toBe(true);
    expect(await store.list()).toHaveLength(1);
    expect(await store.restore(created.id)).toBe(true);
    expect(await store.bumpGrantsVersion(created.id)).toBe(1);
  });

  it("protects the final lead under concurrent demotions", async () => {
    const members = new TeamMembershipStore(env.DB);
    for (const id of ["first", "second"]) {
      await env.DB.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)")
        .bind(id)
        .run();
      await members.add("team_default", id, "lead");
    }
    const results = await Promise.allSettled([
      members.setRole("team_default", "first", "member"),
      members.setRole("team_default", "second", "member"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.any(LastLeadError) }),
    ]);
    expect([...(await members.listForUser("first"))]).toHaveLength(1);
    const leads = (await members.listMembers("team_default")).filter(
      (member) => member.role === "lead"
    );
    expect(leads).toHaveLength(1);
    await expect(members.remove("team_default", leads[0].userId)).rejects.toBeInstanceOf(
      LastLeadError
    );
  });

  it("joins each active auto-join team once with one audit row per joined team", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, created_at, updated_at) VALUES ('new-member', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, auto_join, created_at, updated_at) VALUES ('team_open', 'open-team', 'Open', 1, 1, 1), ('team_archived', 'archived-team', 'Archived', 1, 1, 1)"
    ).run();
    await env.DB.prepare("UPDATE teams SET archived_at = 2 WHERE id = 'team_archived'").run();
    const members = new TeamMembershipStore(env.DB);
    await sqlDatabase(env.DB).batch(members.autoJoinStatements("new-member", 10));
    await sqlDatabase(env.DB).batch(members.autoJoinStatements("new-member", 11));
    expect([...(await members.listForUser("new-member"))]).toEqual([
      ["team_default", "member"],
      ["team_open", "member"],
    ]);
    const audit = await env.DB.prepare(
      "SELECT team_id FROM authorization_audit_events WHERE action = 'team.member_auto_joined' AND target_user_id_snapshot = 'new-member' ORDER BY team_id"
    ).all();
    expect(audit.results).toEqual([{ team_id: "team_default" }, { team_id: "team_open" }]);
    expect(
      (await new TeamStore(env.DB).list({ forUserId: "new-member" })).map((team) => team.id).sort()
    ).toEqual(["team_default", "team_open"]);
  });
});
