import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { SlackChannelStore } from "../../src/db/slack-channel-store";
import { generateInternalToken } from "../../src/auth/internal";
import { cleanD1Tables } from "./cleanup";
import type { TriggerConfig } from "@open-inspect/shared";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function makeSlackAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Slack triage",
    repo_owner: "acme",
    repo_name: "web-app",
    base_branch: "main",
    repo_id: 12345,
    instructions: "Investigate and fix",
    trigger_type: "slack_event",
    schedule_cron: null,
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: "user-1",
    user_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: "message.posted",
    trigger_config: null,
    trigger_auth_data: null,
    ...overrides,
  };
}

function createBody(overrides: Record<string, unknown>) {
  return {
    name: "Slack triage",
    instructions: "Investigate the report",
    repoOwner: "acme",
    repoName: "web-app",
    triggerType: "slack_event",
    ...overrides,
  };
}

async function postAutomation(body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch("https://test.local/automations", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
}

describe("POST /automations — slack_event validation (integration)", () => {
  beforeEach(cleanD1Tables);

  it("rejects a slack_event without a slack_channel condition (400)", async () => {
    const res = await postAutomation(createBody({ triggerConfig: { conditions: [] } }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("slack_channel");
  });

  it("accepts a slack_event with only a slack_channel condition (no text_match)", async () => {
    const res = await postAutomation(
      createBody({
        triggerConfig: {
          conditions: [{ type: "slack_channel", operator: "any_of", value: ["C1"] }],
        },
      })
    );
    // text_match is optional; the channel-only config passes validation and only
    // later fails at repo resolution in the test env.
    expect(res.status).not.toBe(400);
  });

  it("rejects a slack_channel value that is not an array of strings (400)", async () => {
    const res = await postAutomation(
      createBody({
        triggerConfig: {
          conditions: [
            { type: "slack_channel", operator: "any_of", value: "C1" },
            { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
          ],
        },
      })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("slack_channel");
  });

  it("rejects an invalid regex text_match at save time (400)", async () => {
    const res = await postAutomation(
      createBody({
        triggerConfig: {
          conditions: [
            { type: "slack_channel", operator: "any_of", value: ["C1"] },
            { type: "text_match", operator: "regex", value: { pattern: "(" } },
          ],
        },
      })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid regex");
  });

  it("rejects a disallowed regex flag at save time (400)", async () => {
    const res = await postAutomation(
      createBody({
        triggerConfig: {
          conditions: [
            { type: "slack_channel", operator: "any_of", value: ["C1"] },
            { type: "text_match", operator: "regex", value: { pattern: "deploy", flags: "g" } },
          ],
        },
      })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unsupported regex flag");
  });

  it("accepts slack_event past the trigger-type allowlist (no unknown-trigger 400)", async () => {
    // Valid scoping passes validation; the request then fails later at repository
    // resolution (no GitHub App in the test env). The point is that slack_event is
    // NOT rejected as an unknown trigger type before reaching that stage.
    const res = await postAutomation(
      createBody({
        triggerConfig: {
          conditions: [
            { type: "slack_channel", operator: "any_of", value: ["C1"] },
            { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
          ],
        },
      })
    );
    expect(await res.text()).not.toContain("triggerType must be one of");
  });
});

describe("PUT /automations/:id — slack_event validation (integration)", () => {
  beforeEach(cleanD1Tables);

  async function putAutomation(id: string, body: Record<string, unknown>): Promise<Response> {
    return SELF.fetch(`https://test.local/automations/${id}`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
  }

  it("rejects a non-array conditions on update with 400, not 500", async () => {
    const store = new AutomationStore(env.DB);
    const auto = makeSlackAutomation();
    await store.create(auto);

    const res = await putAutomation(auto.id, { triggerConfig: { conditions: "not-an-array" } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("must be an array");
  });

  it("atomically updates conditions and re-syncs the watched-channel index", async () => {
    const store = new AutomationStore(env.DB);
    const channels = new SlackChannelStore(env.DB);
    const auto = makeSlackAutomation();
    await store.create(auto);
    await channels.setSlackChannels(auto.id, ["C1"]);

    const res = await putAutomation(auto.id, {
      triggerConfig: {
        conditions: [
          { type: "slack_channel", operator: "any_of", value: ["C2", "C3"] },
          { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
        ],
      },
    });
    expect(res.status).toBe(200);

    const watched = await channels.getWatchedSlackChannels();
    expect([...watched].sort()).toEqual(["C2", "C3"]);
  });

  it("replaces trigger_config wholesale on update", async () => {
    const store = new AutomationStore(env.DB);
    const auto = makeSlackAutomation({
      trigger_config: JSON.stringify({
        conditions: [
          { type: "slack_channel", operator: "any_of", value: ["C1"] },
          { type: "text_match", operator: "contains", value: { pattern: "old" } },
        ],
      }),
    });
    await store.create(auto);

    // A PUT replaces the whole blob. The client owns the full trigger_config.
    const res = await putAutomation(auto.id, {
      triggerConfig: {
        conditions: [
          { type: "slack_channel", operator: "any_of", value: ["C9"] },
          { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
        ],
      },
    });
    expect(res.status).toBe(200);

    const config = JSON.parse((await store.getById(auto.id))!.trigger_config!) as TriggerConfig;
    expect(config.conditions.find((c) => c.type === "slack_channel")?.value).toEqual(["C9"]);
  });

  it("rejects clearing trigger_config to null on a slack_event automation (400)", async () => {
    const store = new AutomationStore(env.DB);
    const channels = new SlackChannelStore(env.DB);
    const auto = makeSlackAutomation({
      trigger_config: JSON.stringify({
        conditions: [
          { type: "slack_channel", operator: "any_of", value: ["C1"] },
          { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
        ],
      }),
    });
    await store.create(auto);
    await channels.setSlackChannels(auto.id, ["C1"]);

    const res = await putAutomation(auto.id, { triggerConfig: null });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Cannot clear triggerConfig");

    // The rejected request left both the config and the derived index intact —
    // an enabled-but-untriggerable state never materializes.
    expect((await store.getById(auto.id))!.trigger_config).not.toBeNull();
    expect([...(await channels.getWatchedSlackChannels())]).toEqual(["C1"]);
  });
});

describe("GET /integration-settings/slack/watched-channels (integration)", () => {
  beforeEach(cleanD1Tables);

  async function getWatchedChannels(): Promise<Response> {
    return SELF.fetch("https://test.local/integration-settings/slack/watched-channels", {
      method: "GET",
      headers: await authHeaders(),
    });
  }

  it("returns 401 without an internal token", async () => {
    const res = await SELF.fetch("https://test.local/integration-settings/slack/watched-channels", {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("returns the distinct watched channels for enabled slack automations", async () => {
    const store = new AutomationStore(env.DB);
    const channels = new SlackChannelStore(env.DB);
    const a = makeSlackAutomation();
    const b = makeSlackAutomation();
    await store.create(a);
    await store.create(b);
    await channels.setSlackChannels(a.id, ["C1", "C2"]);
    await channels.setSlackChannels(b.id, ["C2", "C3"]);

    const res = await getWatchedChannels();
    expect(res.status).toBe(200);
    const body = await res.json<{ channels: string[] }>();
    expect([...body.channels].sort()).toEqual(["C1", "C2", "C3"]);
  });

  it("excludes channels of disabled automations and returns an empty list when none", async () => {
    const store = new AutomationStore(env.DB);
    const channels = new SlackChannelStore(env.DB);
    const disabled = makeSlackAutomation({ enabled: 0 });
    await store.create(disabled);
    await channels.setSlackChannels(disabled.id, ["C9"]);

    const res = await getWatchedChannels();
    expect(res.status).toBe(200);
    const body = await res.json<{ channels: string[] }>();
    expect(body.channels).toEqual([]);
  });
});

describe("GET /integration-settings/slack/channels (integration)", () => {
  beforeEach(cleanD1Tables);

  async function getSlackChannels(auth = true): Promise<Response> {
    return SELF.fetch("https://test.local/integration-settings/slack/channels", {
      method: "GET",
      headers: auth ? await authHeaders() : undefined,
    });
  }

  it("returns 401 without an internal token", async () => {
    const res = await getSlackChannels(false);
    expect(res.status).toBe(401);
  });

  it("degrades to an empty channel list (never a 500) when listing is unavailable", async () => {
    // The integration env has no usable bot token, so the route returns an empty
    // list with an error — `not_configured` when unset, or a Slack error such as
    // `invalid_auth` when a placeholder token is present — rather than throwing.
    const res = await getSlackChannels();
    expect(res.status).toBe(200);
    const body = await res.json<{ channels: string[]; error?: string }>();
    expect(body.channels).toEqual([]);
    expect(typeof body.error).toBe("string");
    expect(body.error).toBeTruthy();
  });
});
