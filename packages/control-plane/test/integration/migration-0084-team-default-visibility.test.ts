import { env } from "cloudflare:test";
import type { TeamDefaultVisibility } from "@open-inspect/shared/types/teams";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { cleanD1Tables } from "./cleanup";

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

describe("migration 0084: team default visibility", () => {
  it("upgrades legacy defaults without changing private sessions or team dependents", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, created_at, updated_at) VALUES
          ('owner', 1, 2), ('collaborator', 3, 4)`
      ),
      env.DB.prepare(
        `INSERT INTO teams
          (id, slug, name, default_visibility, archived_at, created_at, updated_at)
         VALUES
          ('team_private', 'private', 'Active', 'private', NULL, 10, 11),
          ('team_private_archived', 'archived', 'Archived', 'private', 50, 20, 21),
          ('team_team', 'team', 'Team', 'team', NULL, 30, 31),
          ('team_workspace', 'workspace', 'Workspace', 'workspace', NULL, 40, 41)`
      ),
      env.DB.prepare(
        `INSERT INTO team_memberships (team_id, user_id, role, source, created_at) VALUES
          ('team_private', 'owner', 'lead', 'manual', 12),
          ('team_private_archived', 'collaborator', 'member', 'github_team', 22)`
      ),
      env.DB.prepare(
        `INSERT INTO team_repository_grants
          (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
         VALUES
          ('active-grant', 'team_private', 'repository', 123, 'acme', 'repo', 14),
          ('archived-grant', 'team_private_archived', 'installation', NULL, NULL, NULL, 24)`
      ),
      env.DB.prepare(
        `INSERT INTO sessions
          (id, user_id, owner_team_id, visibility, created_at, updated_at)
         VALUES
          ('private-session', 'owner', 'team_private', 'private', 100, 110),
          ('archived-private-session', 'owner', 'team_private_archived', 'private', 120, 130)`
      ),
      env.DB.prepare(
        `INSERT INTO session_collaborators (session_id, user_id, added_by, created_at) VALUES
          ('private-session', 'collaborator', 'owner', 111),
          ('archived-private-session', 'collaborator', 'owner', 131)`
      ),
    ]);

    const snapshot = async () => {
      const [teams, sessions, collaborators, memberships, grants] = await env.DB.batch<
        Record<string, unknown>
      >([
        env.DB.prepare("SELECT * FROM teams ORDER BY id"),
        env.DB.prepare("SELECT * FROM sessions ORDER BY id"),
        env.DB.prepare("SELECT * FROM session_collaborators ORDER BY session_id, user_id"),
        env.DB.prepare("SELECT * FROM team_memberships ORDER BY team_id, user_id"),
        env.DB.prepare("SELECT * FROM team_repository_grants ORDER BY id"),
      ]);
      return {
        teams: teams.results,
        sessions: sessions.results,
        collaborators: collaborators.results,
        memberships: memberships.results,
        grants: grants.results,
      };
    };
    const before = await snapshot();
    const expected = {
      ...before,
      teams: before.teams.map((team) => ({
        ...team,
        default_visibility:
          team.default_visibility === "private" ? "team" : team.default_visibility,
      })),
    };

    const migration = env.TEST_MIGRATIONS.find(
      (candidate) => candidate.name === "0084_team_default_visibility.sql"
    );
    if (!migration) throw new Error("Migration 0084 not found in TEST_MIGRATIONS");
    await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));

    expect(await snapshot()).toEqual(expected);
    expect(await new TeamStore(env.DB).list({ includeArchived: true })).toMatchObject([
      { id: "team_private", defaultVisibility: "team", archivedAt: null },
      { id: "team_private_archived", defaultVisibility: "team", archivedAt: 50 },
      { id: "team_team", defaultVisibility: "team", archivedAt: null },
      { id: "team_workspace", defaultVisibility: "workspace", archivedAt: null },
    ]);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("validates TeamStore defaults before persistence", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, created_at, updated_at) VALUES ('owner', 1, 1)"
    ).run();
    const store = new TeamStore(env.DB);
    const team = await store.create({ slug: "team", name: "Team", joinPolicy: "invite_only" });
    const workspace = await store.createWithLead(
      {
        slug: "workspace",
        name: "Workspace",
        joinPolicy: "invite_only",
        defaultVisibility: "workspace",
      },
      "owner",
      "workspace-created"
    );
    expect([team.defaultVisibility, workspace.defaultVisibility]).toEqual(["team", "workspace"]);
    await store.update(team.id, { defaultVisibility: "workspace" });
    await store.update(workspace.id, { defaultVisibility: "team" });
    expect(await store.getById(team.id)).toMatchObject({ defaultVisibility: "workspace" });
    expect(await store.getById(workspace.id)).toMatchObject({ defaultVisibility: "team" });

    const snapshot = async () => {
      const results = await env.DB.batch([
        env.DB.prepare("SELECT * FROM teams ORDER BY id"),
        env.DB.prepare("SELECT * FROM team_memberships ORDER BY team_id, user_id"),
        env.DB.prepare("SELECT * FROM authorization_audit_events ORDER BY id"),
      ]);
      return results.map((result) => result.results);
    };
    const before = await snapshot();
    const input = {
      slug: "private",
      name: "Private",
      joinPolicy: "invite_only" as const,
      defaultVisibility: "private" as TeamDefaultVisibility,
    };
    await expect(store.create(input)).rejects.toThrow();
    await expect(
      store.createWithLead({ ...input, slug: "private-with-lead" }, "owner", "private-created")
    ).rejects.toThrow();
    await expect(
      store.update(team.id, { defaultVisibility: input.defaultVisibility })
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
