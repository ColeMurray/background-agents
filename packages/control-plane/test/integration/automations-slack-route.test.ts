import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { generateInternalToken } from "../../src/auth/internal";
import { cleanD1Tables } from "./cleanup";

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

  it("rejects a slack_event without a text_match condition (400)", async () => {
    const res = await postAutomation(
      createBody({
        triggerConfig: {
          conditions: [{ type: "slack_channel", operator: "any_of", value: ["C1"] }],
        },
      })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("text_match");
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

  const validSlackConditions = [
    { type: "slack_channel", operator: "any_of", value: ["C1"] },
    { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
  ];

  it.each([0, -3, 1.5, "5", true])(
    "rejects a non-positive/non-integer maxRunsPerHour=%p on create (400)",
    async (bad) => {
      const res = await postAutomation(
        createBody({ triggerConfig: { conditions: validSlackConditions }, maxRunsPerHour: bad })
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("maxRunsPerHour");
    }
  );

  it("accepts a null maxRunsPerHour (use the app default)", async () => {
    const res = await postAutomation(
      createBody({ triggerConfig: { conditions: validSlackConditions }, maxRunsPerHour: null })
    );
    // Passes validation; only later fails at repo resolution in the test env.
    expect(res.status).not.toBe(400);
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

  it("rejects a non-positive maxRunsPerHour on update (400)", async () => {
    const store = new AutomationStore(env.DB);
    const auto = makeSlackAutomation();
    await store.create(auto);

    const res = await putAutomation(auto.id, { maxRunsPerHour: 0 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("maxRunsPerHour");
  });

  it("atomically updates conditions and re-syncs the watched-channel index", async () => {
    const store = new AutomationStore(env.DB);
    const auto = makeSlackAutomation();
    await store.create(auto);
    await store.setSlackChannels(auto.id, ["C1"]);

    const res = await putAutomation(auto.id, {
      triggerConfig: {
        conditions: [
          { type: "slack_channel", operator: "any_of", value: ["C2", "C3"] },
          { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
        ],
      },
    });
    expect(res.status).toBe(200);

    const watched = await store.getWatchedSlackChannels();
    expect([...watched].sort()).toEqual(["C2", "C3"]);
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
    const a = makeSlackAutomation();
    const b = makeSlackAutomation();
    await store.create(a);
    await store.create(b);
    await store.setSlackChannels(a.id, ["C1", "C2"]);
    await store.setSlackChannels(b.id, ["C2", "C3"]);

    const res = await getWatchedChannels();
    expect(res.status).toBe(200);
    const body = await res.json<{ channels: string[] }>();
    expect([...body.channels].sort()).toEqual(["C1", "C2", "C3"]);
  });

  it("excludes channels of disabled automations and returns an empty list when none", async () => {
    const store = new AutomationStore(env.DB);
    const disabled = makeSlackAutomation({ enabled: 0 });
    await store.create(disabled);
    await store.setSlackChannels(disabled.id, ["C9"]);

    const res = await getWatchedChannels();
    expect(res.status).toBe(200);
    const body = await res.json<{ channels: string[] }>();
    expect(body.channels).toEqual([]);
  });
});
