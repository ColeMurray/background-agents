import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

beforeEach(cleanD1Tables);

describe("team migration constraints", () => {
  it("rejects unknown owner team ids and restricts deleting a member user", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO sessions (id, owner_team_id, created_at, updated_at) VALUES ('bad-team', 'missing', 1, 1)"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO sessions (id, visibility, created_at, updated_at) VALUES ('unteamed', 'team', 1, 1)"
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare(
      "INSERT INTO users (id, created_at, updated_at) VALUES ('team-user', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_explicit', 'explicit', 'Explicit', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO team_memberships (team_id, user_id, created_at) VALUES ('team_explicit', 'team-user', 1)"
    ).run();
    await expect(
      env.DB.prepare("DELETE FROM users WHERE id = 'team-user'").run()
    ).rejects.toThrow();
  });

  it("keeps workspace environment names unique while allowing the same name in different teams", async () => {
    await env.DB.prepare(
      "INSERT INTO environments (id, name, created_at, updated_at) VALUES ('env_workspace', 'Staging', 1, 1)"
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO environments (id, name, created_at, updated_at) VALUES ('env_duplicate', 'staging', 1, 1)"
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_a', 'a', 'A', 1, 1), ('team_b', 'b', 'B', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO environments (id, name, owner_team_id, created_at, updated_at) VALUES ('env_a', 'Staging', 'team_a', 1, 1), ('env_b', 'Staging', 'team_b', 1, 1)"
    ).run();
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
      "INSERT INTO sessions (id, created_at, updated_at) VALUES ('collab-session', 1, 1)"
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
