import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { EnvironmentStore, type EnvironmentRow } from "../../src/db/environments";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";

beforeEach(cleanD1Tables);

it("persists explicit team and workspace ownership through the stores", async () => {
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_explicit', 'explicit', 'Explicit', 1, 1)"
  ).run();
  const session = new SessionIndexStore(env.DB);
  const sessionInput: SessionEntry = {
    id: "explicit-session",
    title: null,
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    ownerTeamId: "team_explicit",
    visibility: "team",
    createdAt: 1,
    updatedAt: 1,
  };
  await session.create(sessionInput);
  await session.create({
    ...sessionInput,
    id: "workspace-session",
    ownerTeamId: null,
    visibility: "workspace",
  });
  expect((await session.get("explicit-session"))?.ownerTeamId).toBe("team_explicit");
  expect((await session.get("explicit-session"))?.visibility).toBe("team");
  expect((await session.get("workspace-session"))?.ownerTeamId).toBeNull();

  const automation = new AutomationStore(env.DB);
  const automationInput: AutomationRow = {
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
  };
  await automation.create(automationInput);
  await automation.create({
    ...automationInput,
    id: "workspace-automation",
    name: "Workspace",
    owner_team_id: null,
  });
  expect((await automation.getById("explicit-automation"))?.owner_team_id).toBe("team_explicit");
  expect((await automation.getById("workspace-automation"))?.owner_team_id).toBeNull();

  const environments = new EnvironmentStore(env.DB);
  const environmentInput: EnvironmentRow = {
    id: "env_explicit",
    name: "Explicit",
    description: null,
    prebuild_enabled: 0,
    channel_associations: null,
    created_at: 1,
    updated_at: 1,
    owner_team_id: "team_explicit",
  };
  await environments.create(environmentInput, []);
  await environments.create({ ...environmentInput, id: "env_workspace", owner_team_id: null }, []);
  expect((await environments.getById("env_explicit"))?.owner_team_id).toBe("team_explicit");
  expect((await environments.getById("env_workspace"))?.owner_team_id).toBeNull();
  for (const [table, id] of [
    ["sessions", "explicit-session"],
    ["automations", "explicit-automation"],
    ["environments", "env_explicit"],
  ]) {
    expect(
      await env.DB.prepare(`SELECT owner_team_id FROM ${table} WHERE id = ?`).bind(id).first()
    ).toEqual({ owner_team_id: "team_explicit" });
  }
  for (const [table, id] of [
    ["sessions", "workspace-session"],
    ["automations", "workspace-automation"],
    ["environments", "env_workspace"],
  ]) {
    expect(
      await env.DB.prepare(`SELECT owner_team_id FROM ${table} WHERE id = ?`).bind(id).first()
    ).toEqual({ owner_team_id: null });
  }
});

it("reads legacy NULL ownership as workspace ownership", async () => {
  await env.DB.prepare(
    "INSERT INTO sessions (id, created_at, updated_at) VALUES ('null-session', 1, 1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO automations (id, name, instructions, model, created_by, created_at, updated_at) VALUES ('null-auto', 'Old', 'Old', 'model', 'operator', 1, 1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO environments (id, name, created_at, updated_at) VALUES ('env_null', 'Old', 1, 1)"
  ).run();
  expect((await new SessionIndexStore(env.DB).get("null-session"))?.ownerTeamId).toBeNull();
  expect((await new SessionIndexStore(env.DB).get("null-session"))?.visibility).toBe("workspace");
  expect((await new AutomationStore(env.DB).getById("null-auto"))?.owner_team_id).toBeNull();
  expect((await new EnvironmentStore(env.DB).getById("env_null"))?.owner_team_id).toBeNull();
});
