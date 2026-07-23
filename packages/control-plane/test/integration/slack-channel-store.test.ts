import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { SlackChannelStore } from "../../src/db/slack-channel-store";
import { cleanD1Tables } from "./cleanup";

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Automation",
    repo_owner: "acme",
    repo_name: "web-app",
    base_branch: "main",
    repo_id: 12345,
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
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

  it("setSlackChannels writes and replaces the channel set", async () => {
    const store = new AutomationStore(env.DB);
    const channels = new SlackChannelStore(env.DB);
    await store.create(makeSlackAutomation({ id: "auto-s1" }));

    await channels.setSlackChannels("auto-s1", ["C1", "C2"]);
    expect((await channels.getWatchedSlackChannels()).sort()).toEqual(["C1", "C2"]);

    await channels.setSlackChannels("auto-s1", ["C2", "C3"]);
    expect((await channels.getWatchedSlackChannels()).sort()).toEqual(["C2", "C3"]);
  });

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

    await channels.setSlackChannels("auto-s2", ["C1"]);
    await channels.setSlackChannels("auto-s3", ["C1"]); // disabled → excluded
    await channels.setSlackChannels("auto-s4", ["C1"]); // wrong trigger_type → excluded

    const matches = await channels.getSlackAutomationsForChannel("C1");
    expect(matches.map((m) => m.id)).toEqual(["auto-s2"]);
  });

  it("getWatchedSlackChannels dedups and excludes disabled automations", async () => {
    const store = new AutomationStore(env.DB);
    const channels = new SlackChannelStore(env.DB);
    await store.create(makeSlackAutomation({ id: "auto-s5" }));
    await store.create(makeSlackAutomation({ id: "auto-s6" }));
    await store.create(makeSlackAutomation({ id: "auto-s7", enabled: 0 }));

    await channels.setSlackChannels("auto-s5", ["C1", "C2"]);
    await channels.setSlackChannels("auto-s6", ["C2", "C3"]); // C2 duplicated across automations
    await channels.setSlackChannels("auto-s7", ["C9"]); // disabled → excluded

    expect((await channels.getWatchedSlackChannels()).sort()).toEqual(["C1", "C2", "C3"]);
  });
});
