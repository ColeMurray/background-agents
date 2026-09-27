import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

beforeEach(cleanD1Tables);

describe("team migration constraints", () => {
  it("retains the default team across cleanup", async () => {
    const team = await env.DB.prepare(
      "SELECT id, auto_join, is_default FROM teams WHERE id = 'team_default'"
    ).first();
    expect(team).toEqual({ id: "team_default", auto_join: 1, is_default: 1 });
  });

  it("rejects unknown owner team ids and restricts deleting a member user", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO sessions (id, owner_team_id) VALUES ('bad-team', 'missing')"
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare(
      "INSERT INTO users (id, created_at, updated_at) VALUES ('team-user', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO team_memberships (team_id, user_id, created_at) VALUES ('team_default', 'team-user', 1)"
    ).run();
    await expect(
      env.DB.prepare("DELETE FROM users WHERE id = 'team-user'").run()
    ).rejects.toThrow();
  });

  it("cascades archived-team dependents and session collaborators", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, created_at, updated_at) VALUES ('team-user', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_extra', 'extra', 'Extra', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO team_memberships (team_id, user_id, created_at) VALUES ('team_extra', 'team-user', 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO team_repository_grants (id, team_id, grant_kind, created_at) VALUES ('grant-extra', 'team_extra', 'installation', 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO team_channel_bindings (provider, external_id, team_id, created_at) VALUES ('slack', 'channel-extra', 'team_extra', 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO team_secrets (team_id, key, encrypted_value, created_at, updated_at) VALUES ('team_extra', 'secret', 'encrypted', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO sessions (id, owner_team_id, created_at, updated_at) VALUES ('collab-session', 'team_default', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO session_collaborators (session_id, user_id, added_by, created_at) VALUES ('collab-session', 'team-user', 'operator', 1)"
    ).run();

    await env.DB.prepare("DELETE FROM sessions WHERE id = 'collab-session'").run();
    expect((await env.DB.prepare("SELECT * FROM session_collaborators").all()).results).toEqual([]);
    await env.DB.prepare("DELETE FROM teams WHERE id = 'team_extra'").run();
    for (const table of [
      "team_memberships",
      "team_repository_grants",
      "team_channel_bindings",
      "team_secrets",
    ]) {
      expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results).toEqual([]);
    }
  });
});
