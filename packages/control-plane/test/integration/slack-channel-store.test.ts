import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { sqlDatabase } from "./helpers";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { SlackChannelStore } from "../../src/db/slack-channel-store";
import { cleanD1Tables } from "./cleanup";
import { DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS } from "@open-inspect/shared/types/automations";
import { TeamStore } from "../../src/db/teams";

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    owner_team_id: null,
    name: "Test Automation",
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    max_concurrent_runs: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
    next_run_at: now + 86400000,
    consecutive_failures: 0,
    created_by: "user-1",
    user_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    ...overrides,
  };
}

const makeSlackAutomation = (overrides?: Partial<AutomationRow>) =>
  makeAutomation({
    trigger_type: "slack_event",
    event_type: "message.posted",
    ...overrides,
  });

describe("SlackChannelStore (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  it("getSlackAutomationsForChannel returns only enabled, non-deleted slack automations", async () => {
    const store = new AutomationStore(env.DB);
    const channels = new SlackChannelStore(env.DB);
    await store.create(makeSlackAutomation({ id: "auto-s2" }));
    await store.create(makeSlackAutomation({ id: "auto-s3", enabled: 0 }));
    await store.create(
      makeAutomation({
        id: "auto-s4",
        trigger_type: "github_event",
        event_type: "pull_request.opened",
      })
    );

    await sqlDatabase(env.DB).batch(channels.bindChannelStatements("auto-s2", ["C1"]));
    await sqlDatabase(env.DB).batch(channels.bindChannelStatements("auto-s3", ["C1"]));
    await sqlDatabase(env.DB).batch(channels.bindChannelStatements("auto-s4", ["C1"]));

    const matches = await channels.getSlackAutomationsForChannel("C1");
    expect(matches.map((m) => m.id)).toEqual(["auto-s2"]);
  });

  it("getWatchedSlackChannels dedups and excludes disabled automations", async () => {
    const store = new AutomationStore(env.DB);
    const channels = new SlackChannelStore(env.DB);
    await store.create(makeSlackAutomation({ id: "auto-s5" }));
    await store.create(makeSlackAutomation({ id: "auto-s6" }));
    await store.create(makeSlackAutomation({ id: "auto-s7", enabled: 0 }));

    await sqlDatabase(env.DB).batch(channels.bindChannelStatements("auto-s5", ["C1", "C2"]));
    await sqlDatabase(env.DB).batch(channels.bindChannelStatements("auto-s6", ["C2", "C3"]));
    await sqlDatabase(env.DB).batch(channels.bindChannelStatements("auto-s7", ["C9"]));

    expect((await channels.getWatchedSlackChannels()).sort()).toEqual(["C1", "C2", "C3"]);
  });

  it("selects only automations owned by the channel's current team", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "a",
      name: "A",
      joinPolicy: "invite_only",
    });
    const other = await new TeamStore(env.DB).create({
      slug: "b",
      name: "B",
      joinPolicy: "invite_only",
    });
    const store = new AutomationStore(env.DB);
    const channels = new SlackChannelStore(env.DB);
    for (const [id, ownerTeamId] of [
      ["workspace", null],
      ["matching", team.id],
      ["other", other.id],
    ] as const) {
      await store.create(makeSlackAutomation({ id, owner_team_id: ownerTeamId }));
      await sqlDatabase(env.DB).batch(channels.bindChannelStatements(id, ["C1"]));
    }
    expect((await channels.getSlackAutomationsForChannel("C1")).map((row) => row.id)).toEqual([
      "workspace",
    ]);
    await env.DB.prepare(
      "INSERT INTO team_channel_bindings (provider, external_id, team_id, kind, created_at) VALUES ('slack', 'C1', ?, 'source', ?)"
    )
      .bind(team.id, Date.now())
      .run();
    expect((await channels.getSlackAutomationsForChannel("C1")).map((row) => row.id)).toEqual([
      "matching",
    ]);
    await env.DB.prepare("UPDATE team_channel_bindings SET team_id = ? WHERE external_id = 'C1'")
      .bind(other.id)
      .run();
    expect((await channels.getSlackAutomationsForChannel("C1")).map((row) => row.id)).toEqual([
      "other",
    ]);
  });
});
