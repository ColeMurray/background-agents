import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EnvironmentStore, type EnvironmentRow } from "../../src/db/environments";
import { TeamSlugConflictError, TeamStore } from "../../src/db/teams";
import {
  TeamMembershipStore,
  LastLeadError,
  TeamMembershipNotFoundError,
} from "../../src/db/team-memberships";
import { cleanD1Tables } from "./cleanup";

beforeEach(cleanD1Tables);

function environmentRow(overrides: Partial<EnvironmentRow>): EnvironmentRow {
  const now = Date.now();
  return {
    id: "env_test",
    name: "Test Environment",
    description: null,
    prebuild_enabled: 0,
    channel_associations: null,
    created_at: now,
    updated_at: now,
    owner_team_id: null,
    ...overrides,
  };
}

describe("team and membership stores", () => {
  it("validates team rows and allows any team to be archived or restored", async () => {
    const store = new TeamStore(env.DB);
    expect(await store.list()).toEqual([]);
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
    expect(await store.list()).toEqual([]);
    expect(await store.restore(created.id)).toBe(true);
    expect(await store.bumpGrantsVersion(created.id)).toBe(1);
  });

  it("rejects an empty default environment ID without changing the team", async () => {
    const store = new TeamStore(env.DB);
    const team = await store.create({
      slug: "empty-default",
      name: "Empty",
      joinPolicy: "invite_only",
    });
    await expect(store.update(team.id, { defaultEnvironmentId: "" })).rejects.toThrow(
      "Default environment must belong to the team"
    );
    expect((await store.getById(team.id))?.defaultEnvironmentId).toBeNull();
  });

  it("only accepts default environments owned by the team", async () => {
    const teams = new TeamStore(env.DB);
    const environments = new EnvironmentStore(env.DB);
    const team = await teams.create({
      slug: "default-env",
      name: "Default Env",
      joinPolicy: "invite_only",
    });
    const otherTeam = await teams.create({
      slug: "other-default-env",
      name: "Other Default Env",
      joinPolicy: "invite_only",
    });
    await environments.create(
      environmentRow({ id: "env_same_team", name: "Same Team", owner_team_id: team.id }),
      []
    );
    await environments.create(
      environmentRow({ id: "env_other_team", name: "Other Team", owner_team_id: otherTeam.id }),
      []
    );

    await expect(
      teams.update(team.id, { defaultEnvironmentId: "env_same_team" })
    ).resolves.toMatchObject({ defaultEnvironmentId: "env_same_team" });

    await expect(teams.update(team.id, { defaultEnvironmentId: "env_other_team" })).rejects.toThrow(
      "Default environment must belong to the team"
    );
    await expect(teams.update(team.id, { defaultEnvironmentId: "env_missing" })).rejects.toThrow(
      "Default environment must belong to the team"
    );
    expect((await teams.getById(team.id))?.defaultEnvironmentId).toBe("env_same_team");
  });

  it("reports duplicate slugs as a typed store conflict", async () => {
    const store = new TeamStore(env.DB);
    await store.create({ slug: "duplicate", name: "First", joinPolicy: "invite_only" });
    await expect(
      store.create({ slug: "duplicate", name: "Second", joinPolicy: "invite_only" })
    ).rejects.toBeInstanceOf(TeamSlugConflictError);
  });

  it("rechecks open and active policy when a user joins, without restricting manual additions", async () => {
    const teams = new TeamStore(env.DB);
    const members = new TeamMembershipStore(env.DB);
    const team = await teams.create({ slug: "join-race", name: "Join race", joinPolicy: "open" });
    for (const userId of ["joiner", "invited"]) {
      await env.DB.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)")
        .bind(userId)
        .run();
    }

    await teams.update(team.id, { joinPolicy: "invite_only" });
    expect(await members.addIfJoinable(team.id, "joiner")).toBe(false);
    expect(await members.add(team.id, "invited")).toBe(true);
    await teams.update(team.id, { joinPolicy: "open" });
    await teams.archive(team.id);
    expect(await members.addIfJoinable(team.id, "joiner")).toBe(false);
    expect((await members.listForUser("joiner")).has(team.id)).toBe(false);

    await teams.restore(team.id);
    expect(await members.addIfJoinable(team.id, "joiner")).toBe(true);
    expect(await members.addIfJoinable(team.id, "joiner")).toBe(false);
    expect((await members.listForUser("joiner")).get(team.id)).toBe("member");
  });

  it("protects the final lead under concurrent demotions", async () => {
    const members = new TeamMembershipStore(env.DB);
    const teamId = (
      await new TeamStore(env.DB).create({
        slug: "leads",
        name: "Leads",
        joinPolicy: "invite_only",
      })
    ).id;
    for (const id of ["first", "second"]) {
      await env.DB.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)")
        .bind(id)
        .run();
      await members.add(teamId, id, "lead");
    }
    const results = await Promise.allSettled([
      members.setRole(teamId, "first", "member"),
      members.setRole(teamId, "second", "member"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.any(LastLeadError) }),
    ]);
    expect([...(await members.listForUser("first"))]).toHaveLength(1);
    const leads = (await members.listMembers(teamId)).filter((member) => member.role === "lead");
    expect(leads).toHaveLength(1);
    await expect(members.remove(teamId, leads[0].userId)).rejects.toBeInstanceOf(LastLeadError);
  });

  it("distinguishes missing memberships from the final lead and permits an unchanged lead", async () => {
    const members = new TeamMembershipStore(env.DB);
    const teamId = (
      await new TeamStore(env.DB).create({
        slug: "only-lead",
        name: "Only Lead",
        joinPolicy: "invite_only",
      })
    ).id;
    await env.DB.prepare(
      "INSERT INTO users (id, created_at, updated_at) VALUES ('only-lead', 1, 1)"
    ).run();
    expect(await members.listForUser("only-lead")).toEqual(new Map());
    await members.add(teamId, "only-lead", "lead");

    await expect(members.setRole(teamId, "only-lead", "lead")).resolves.toBeUndefined();
    await expect(members.setRole(teamId, "only-lead", "member")).rejects.toBeInstanceOf(
      LastLeadError
    );
    await expect(members.remove(teamId, "only-lead")).rejects.toBeInstanceOf(LastLeadError);
    await expect(members.setRole(teamId, "missing", "member")).rejects.toBeInstanceOf(
      TeamMembershipNotFoundError
    );
    await expect(members.remove(teamId, "missing")).rejects.toBeInstanceOf(
      TeamMembershipNotFoundError
    );
  });
});
