import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { AutomationStore } from "../../src/db/automation-store";
import { EnvironmentStore } from "../../src/db/environments";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";

beforeEach(cleanD1Tables);

it("persists explicit non-default owners through session, automation and environment stores", async () => {
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_explicit', 'explicit', 'Explicit', 1, 1)"
  ).run();
  const session = new SessionIndexStore(env.DB);
  await session.create({
    id: "explicit-session",
    title: null,
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    ownerTeamId: "team_explicit",
    visibility: "workspace",
    createdAt: 1,
    updatedAt: 1,
  });
  expect((await session.get("explicit-session"))?.ownerTeamId).toBe("team_explicit");
  expect((await session.get("explicit-session"))?.visibility).toBe("workspace");

  const automation = new AutomationStore(env.DB);
  await automation.create({
    id: "explicit-automation",
    name: "Explicit",
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: null,
    schedule_tz: "UTC",
    harness: "opencode",
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: null,
    enabled: 0,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: "operator",
    user_id: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    owner_team_id: "team_explicit",
  });
  expect((await automation.getById("explicit-automation"))?.owner_team_id).toBe("team_explicit");

  const environments = new EnvironmentStore(env.DB);
  await environments.create(
    {
      id: "env_explicit",
      name: "Explicit",
      description: null,
      prebuild_enabled: 0,
      channel_associations: null,
      created_at: 1,
      updated_at: 1,
      owner_team_id: "team_explicit",
    },
    []
  );
  expect((await environments.getById("env_explicit"))?.owner_team_id).toBe("team_explicit");
  for (const [table, id] of [
    ["sessions", "explicit-session"],
    ["automations", "explicit-automation"],
    ["environments", "env_explicit"],
  ]) {
    expect(
      await env.DB.prepare(`SELECT owner_team_id FROM ${table} WHERE id = ?`).bind(id).first()
    ).toEqual({ owner_team_id: "team_explicit" });
  }
});

it("maps deploy-window NULL ownership to the default team on reads", async () => {
  await env.DB.prepare(
    "INSERT INTO sessions (id, created_at, updated_at) VALUES ('null-session', 1, 1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO automations (id, name, instructions, model, created_by, created_at, updated_at) VALUES ('null-auto', 'Old', 'Old', 'model', 'operator', 1, 1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO environments (id, name, created_at, updated_at) VALUES ('env_null', 'Old', 1, 1)"
  ).run();
  expect((await new SessionIndexStore(env.DB).get("null-session"))?.ownerTeamId).toBe(
    "team_default"
  );
  expect((await new AutomationStore(env.DB).getById("null-auto"))?.owner_team_id).toBe(
    "team_default"
  );
  expect((await new EnvironmentStore(env.DB).getById("env_null"))?.owner_team_id).toBe(
    "team_default"
  );
});
