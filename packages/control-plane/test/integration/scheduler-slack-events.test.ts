import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  collectMessages,
  initNamedSession,
  openSandboxWs,
  seedSandboxAuth,
  waitForSandboxStatus,
  seedActiveUser,
  sqlDatabase,
  closeWebSocket,
} from "./helpers";
import { getUserAuth } from "../../src/auth/user/runtime";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { SlackChannelStore } from "../../src/db/slack-channel-store";
import type { SlackAutomationEvent } from "@open-inspect/shared/triggers";
import { cleanD1Tables } from "./cleanup";
import { createScheduler } from "../../src/scheduler/factory";
import {
  SLACK_BOT_TRIGGER_LIMIT,
  SLACK_BOT_TRIGGER_WINDOW_MS,
} from "../../src/scheduler/slack-bot-trigger-policy";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { makeRunRow, seedRun, fetchRuns } from "./run-helpers";
import { DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS } from "@open-inspect/shared/types/automations";

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    owner_team_id: null,
    name: "Slack triage",
    instructions: "Investigate and fix",
    trigger_type: "slack_event",
    schedule_cron: null,
    schedule_once_at: null,
    schedule_tz: "UTC",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    max_concurrent_runs: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: "user-1",
    user_id: "user-1",
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: "message.posted",
    trigger_config: JSON.stringify({
      conditions: [
        { type: "slack_channel", operator: "any_of", value: ["C1"] },
        { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
      ],
    }),
    trigger_auth_data: null,
    ...overrides,
  };
}

function makeSlackEvent(overrides?: Partial<SlackAutomationEvent>): SlackAutomationEvent {
  const ts = `${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
  return {
    source: "slack",
    eventType: "message.posted",
    triggerKey: `slack:msg:C1:${ts}`,
    concurrencyKey: `slack:C1:${ts}`,
    contextBlock: "A message was posted in Slack channel #ops by user U1.",
    meta: {},
    channelId: "C1",
    ts,
    actorUserId: "U1",
    text: "please deploy the api",
    ...overrides,
  };
}

function sendEvent(event: SlackAutomationEvent) {
  return createScheduler(env.DB, createCloudflareEnv(env), { submit() {} }).event(event);
}

/** Create a watched slack_event automation (channel C1, text_match contains "deploy"). */
async function seedSlackAutomation(
  store: AutomationStore,
  overrides?: Partial<AutomationRow>
): Promise<string> {
  const id = `auto-slack-${Math.random().toString(36).slice(2, 8)}`;
  await store.create(makeAutomation({ id, ...overrides }));
  const channels = new SlackChannelStore(env.DB);
  await sqlDatabase(env.DB).batch(channels.bindChannelStatements(id, ["C1"]));
  return id;
}

/** The automation's invocations, newest first. */
async function fetchInvocations(store: AutomationStore, automationId: string) {
  const { invocations } = await store.listInvocations(automationId, { limit: 20, offset: 0 });
  return invocations;
}

describe("Scheduler slack event handling (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("user-1");
    await seedActiveUser("slack-actor-1");
    await env.DB.prepare(
      `INSERT INTO user_identities
        (id, user_id, provider, provider_user_id, provider_issuer, created_at, updated_at)
       VALUES ('slack-identity-1', 'slack-actor-1', 'slack', 'U1',
         'https://slack.com', 1, 1)`
    ).run();
  });

  it("triggers a matching slack automation and records thread coordinates", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const event = makeSlackEvent({ text: "please deploy the api" });
    const result = await sendEvent(event);
    expect(result.triggered).toBe(1);

    const runs = await fetchRuns(id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    // The firing keys and message coordinates live on the invocation.
    const invocation = await store.getInvocationById(runs[0]!.invocation_id);
    expect(invocation!.trigger_key).toBe(event.triggerKey);
    const metadata = JSON.parse(invocation!.trigger_metadata!);
    expect(metadata.channel).toBe("C1");
    expect(metadata.messageTs).toBe(event.ts);
  });

  it("does not trigger when the text_match condition fails", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const result = await sendEvent(makeSlackEvent({ text: "good morning team" }));
    expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0, invocationIds: [] });

    expect(await fetchRuns(id)).toHaveLength(0);
  });

  it("does not trigger when the channel is not watched (no candidate)", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    // Event in an unwatched channel — the join table returns no candidate.
    const result = await sendEvent(
      makeSlackEvent({
        channelId: "C2",
        text: "please deploy",
        triggerKey: "slack:msg:C2:1",
        concurrencyKey: "slack:C2:1",
      })
    );
    expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0, invocationIds: [] });

    expect(await fetchRuns(id)).toHaveLength(0);
  });

  describe("bot-authored messages", () => {
    const fromBot = { actorUserId: undefined, botId: "BALERTS", text: "Cost anomaly" };
    // Accepting bots requires a Slack User include list; U1 keeps the person's
    // messages triggering alongside the listed bot.
    const botTriggerConfig = (includeBotMessages?: boolean) =>
      JSON.stringify({
        conditions: [
          { type: "slack_channel", operator: "any_of", value: ["C1"] },
          ...(includeBotMessages
            ? [{ type: "slack_actor", operator: "include", value: ["BALERTS", "U1"] }]
            : []),
        ],
        ...(includeBotMessages === undefined ? {} : { slack: { includeBotMessages } }),
      });

    it("does not trigger an automation that has not opted in", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig() });

      const result = await sendEvent(makeSlackEvent(fromBot));
      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0, invocationIds: [] });
      expect(await fetchRuns(id)).toHaveLength(0);
    });

    it("does not trigger when includeBotMessages is false", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(false) });

      const result = await sendEvent(makeSlackEvent(fromBot));
      expect(result.triggered).toBe(0);
      expect(await fetchRuns(id)).toHaveLength(0);
    });

    it("triggers an automation that opted in to bot messages", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });

      const result = await sendEvent(makeSlackEvent(fromBot));
      expect(result.triggered).toBe(1);
      expect(await fetchRuns(id)).toHaveLength(1);
    });

    it("still triggers on a person's message when the automation opted in", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });

      const result = await sendEvent(makeSlackEvent({ text: "Cost anomaly" }));
      expect(result.triggered).toBe(1);
      expect(await fetchRuns(id)).toHaveLength(1);
    });

    async function actorKindOf(invocationId: string): Promise<string | undefined> {
      const row = await env.DB.prepare("SELECT actor_kind FROM automation_invocations WHERE id = ?")
        .bind(invocationId)
        .first<{ actor_kind: string }>();
      return row?.actor_kind;
    }

    async function seedBotFirings(automationId: string, count: number, createdAt: number) {
      for (let i = 0; i < count; i++) {
        await env.DB.prepare(
          `INSERT INTO automation_invocations
            (id, automation_id, source, actor_kind, trigger_key, concurrency_key,
             trigger_metadata, created_at, updated_at)
           VALUES (?, ?, 'event', 'bot', ?, ?, ?, ?, ?)`
        )
          .bind(
            `inv-bot-${automationId}-${i}`,
            automationId,
            `slack:msg:C1:seed-${i}`,
            `slack:C1:seed-${i}`,
            JSON.stringify({ channel: "C1", messageTs: `seed-${i}`, botId: "BALERTS" }),
            createdAt,
            createdAt
          )
          .run();
      }
    }

    it("stops starting bot-triggered runs once the hourly limit is reached", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });
      await seedBotFirings(id, SLACK_BOT_TRIGGER_LIMIT, Date.now() - 60_000);

      const botResult = await sendEvent(makeSlackEvent(fromBot));
      expect(botResult).toMatchObject({ triggered: 0, skipped: 1 });
      expect(await fetchRuns(id)).toHaveLength(0);
      const skip = (await fetchInvocations(store, id)).find(
        (invocation) => invocation.skipReason === "slack_bot_trigger_limit"
      );
      expect(skip).toBeDefined();
      expect(botResult.invocationIds).toEqual([skip!.id]);
      expect(await actorKindOf(skip!.id)).toBe("bot");

      // Later refusals in the window are counted but leave no further rows.
      const laterResult = await sendEvent(makeSlackEvent(fromBot));
      expect(laterResult).toEqual({ triggered: 0, skipped: 1, steered: 0, invocationIds: [] });
      expect(
        (await fetchInvocations(store, id)).filter(
          (invocation) => invocation.skipReason === "slack_bot_trigger_limit"
        )
      ).toHaveLength(1);

      // People are not limited.
      const personResult = await sendEvent(makeSlackEvent({ text: "Cost anomaly" }));
      expect(personResult.triggered).toBe(1);
    });

    it("resolves a redelivered bot message to its firing instead of the limit", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });
      await seedBotFirings(id, SLACK_BOT_TRIGGER_LIMIT, Date.now() - 60_000);
      const redelivered = makeSlackEvent({
        ...fromBot,
        triggerKey: "slack:msg:C1:seed-0",
      });

      const result = await sendEvent(redelivered);
      expect(result.invocationIds).toEqual([`inv-bot-${id}-0`]);
      expect(
        (await fetchInvocations(store, id)).some(
          (invocation) => invocation.skipReason === "slack_bot_trigger_limit"
        )
      ).toBe(false);
    });

    it("counts only bot firings inside the window", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });
      await seedBotFirings(
        id,
        SLACK_BOT_TRIGGER_LIMIT,
        Date.now() - SLACK_BOT_TRIGGER_WINDOW_MS - 1
      );

      const result = await sendEvent(makeSlackEvent(fromBot));
      expect(result.triggered).toBe(1);
    });

    it("records bot-started firings as bot, keeping the bot's id in the metadata", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });

      await sendEvent(makeSlackEvent(fromBot));

      const row = await env.DB.prepare(
        "SELECT actor_kind, trigger_metadata FROM automation_invocations WHERE automation_id = ?"
      )
        .bind(id)
        .first<{ actor_kind: string; trigger_metadata: string }>();
      expect(row!.actor_kind).toBe("bot");
      // A worker rolled back past actor_kind counts bot firings by this key.
      expect(JSON.parse(row!.trigger_metadata)).toMatchObject({ botId: "BALERTS" });
    });

    it("records a person's firing as person", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });

      await sendEvent(makeSlackEvent({ text: "Cost anomaly" }));

      const [invocation] = await fetchInvocations(store, id);
      expect(await actorKindOf(invocation!.id)).toBe("person");
    });

    it("counts the automation's unskipped firings by actor kind since a time, up to a limit", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });
      const otherId = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });
      const now = Date.now();
      const botMetadata = JSON.stringify({ channel: "C1", messageTs: "1", botId: "B1" });
      const rows: Array<[string, string, string | null, string | null, number]> = [
        [id, "bot", botMetadata, null, now],
        // Counted by the column alone, whatever the metadata says.
        [id, "bot", null, null, now],
        [id, "person", JSON.stringify({ channel: "C1", messageTs: "3" }), null, now],
        // Metadata naming a bot does not make a firing count.
        [id, "person", botMetadata, null, now],
        [id, "unknown", botMetadata, null, now],
        [id, "bot", botMetadata, "slack_bot_trigger_limit", now],
        [id, "bot", botMetadata, null, now - 10_000],
        [otherId, "bot", botMetadata, null, now],
      ];
      for (const [
        i,
        [automationId, actorKind, metadata, skipReason, createdAt],
      ] of rows.entries()) {
        await env.DB.prepare(
          `INSERT INTO automation_invocations
            (id, automation_id, source, actor_kind, trigger_metadata, skip_reason, created_at,
             updated_at)
           VALUES (?, ?, 'event', ?, ?, ?, ?, ?)`
        )
          .bind(
            `inv-count-${i}`,
            automationId,
            actorKind,
            metadata,
            skipReason,
            createdAt,
            createdAt
          )
          .run();
      }

      const since = now - 1_000;
      expect(await store.countFiringsSince(id, { actorKind: "bot", since, limit: 10 })).toBe(2);
      expect(await store.countFiringsSince(id, { actorKind: "person", since, limit: 10 })).toBe(2);
      // Stops scanning once the limit is reached.
      expect(await store.countFiringsSince(id, { actorKind: "bot", since, limit: 1 })).toBe(1);
    });

    it("ignores bot messages when the opted-in automation has no Slack User include list", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, {
        trigger_config: JSON.stringify({
          conditions: [{ type: "slack_channel", operator: "any_of", value: ["C1"] }],
          slack: { includeBotMessages: true },
        }),
      });

      const result = await sendEvent(makeSlackEvent(fromBot));
      expect(result).toEqual({ triggered: 0, skipped: 0, steered: 0, invocationIds: [] });
      expect(await fetchRuns(id)).toHaveLength(0);
    });

    it("does not trigger on a bot missing from the include list", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });

      const result = await sendEvent(makeSlackEvent({ ...fromBot, botId: "BOTHER" }));
      expect(result.triggered).toBe(0);
      expect(await fetchRuns(id)).toHaveLength(0);
    });

    it("does not let a bot's thread reply reach an excluded automation's session", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store);
      const concurrencyKey = "slack:C1:thread-bot";

      const rootResult = await sendEvent(
        makeSlackEvent({ text: "deploy the api", concurrencyKey, triggerKey: "slack:msg:C1:r" })
      );
      expect(rootResult.triggered).toBe(1);

      const replyResult = await sendEvent(
        makeSlackEvent({
          ...fromBot,
          text: "deploy finished",
          concurrencyKey,
          triggerKey: "slack:msg:C1:bot-reply",
        })
      );
      expect(replyResult).toEqual({ triggered: 0, skipped: 0, steered: 0, invocationIds: [] });
      expect(await fetchRuns(id)).toHaveLength(1);
    });

    it("drops a bot's thread reply to an opted-in automation's session instead of steering", async () => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store, { trigger_config: botTriggerConfig(true) });
      const concurrencyKey = "slack:C1:thread-opted-in";

      const rootResult = await sendEvent(
        makeSlackEvent({ concurrencyKey, triggerKey: "slack:msg:C1:root-opted-in" })
      );
      expect(rootResult.triggered).toBe(1);

      const replyResult = await sendEvent(
        makeSlackEvent({
          ...fromBot,
          text: "deploy finished",
          concurrencyKey,
          triggerKey: "slack:msg:C1:bot-reply-opted-in",
        })
      );
      expect(replyResult).toEqual({ triggered: 0, skipped: 1, steered: 0, invocationIds: [] });
      expect(await fetchRuns(id)).toHaveLength(1);
    });
  });

  it("holds a reply until the thread's starting run has queued its first prompt", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    // A run still in "starting" has not created its session yet. A reply is held
    // for it rather than dropped with the "already active" notice, and is queued
    // after the run's own first prompt. (Delivery to a real session is covered by
    // scheduler-webhook-session.test.ts.)
    const concurrencyKey = "slack:C1:thread-1";
    // The active run's concurrency key lives on its invocation.
    const activeInvId = "inv-active-1";
    await env.DB.prepare(
      `INSERT INTO automation_invocations
         (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
          trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
       VALUES (?, ?, 'event', NULL, 'slack:msg:C1:first', ?, NULL, NULL, NULL, ?, ?)`
    )
      .bind(activeInvId, id, concurrencyKey, Date.now(), Date.now())
      .run();
    await seedRun(
      makeRunRow(id, {
        id: "active-1",
        invocation_id: activeInvId,
        status: "starting",
        session_id: null,
      })
    );

    const result = await sendEvent(
      makeSlackEvent({ text: "deploy", concurrencyKey, triggerKey: "slack:msg:C1:second" })
    );
    expect(result).toEqual({
      triggered: 0,
      skipped: 0,
      steered: 1,
      invocationIds: [activeInvId],
    });

    const held = await store.getHeldPrompts("active-1");
    expect(held).toHaveLength(1);
    expect(JSON.parse(held[0]!.prompt)).toMatchObject({
      content: "deploy",
      source: "slack",
      callbackContext: { source: "slack", channel: "C1" },
    });
    const invocations = await fetchInvocations(store, id);
    expect(
      invocations.find((invocation) => invocation.skipReason === "concurrent_run_active")
    ).toBeUndefined();
  });

  it("steers the running session when the Slack actor may collaborate", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const concurrencyKey = "slack:C1:thread-steer";
    // Root message triggers the run and creates its session.
    const rootResult = await sendEvent(
      makeSlackEvent({ text: "deploy the api", concurrencyKey, triggerKey: "slack:msg:C1:root" })
    );
    expect(rootResult.triggered).toBe(1);

    // A follow-up reply in the same thread (same concurrency key, new message)
    // is routed to the running session as a steering turn — not skipped.
    const followResult = await sendEvent(
      makeSlackEvent({
        text: "also update the changelog",
        concurrencyKey,
        triggerKey: "slack:msg:C1:reply",
      })
    );
    expect(followResult).toEqual({
      triggered: 0,
      skipped: 0,
      steered: 1,
      invocationIds: rootResult.invocationIds,
    });

    // No concurrency-skip invocation recorded — the follow-up was steered.
    const invocations = await fetchInvocations(store, id);
    expect(
      invocations.find((invocation) => invocation.skipReason === "concurrent_run_active")
    ).toBeUndefined();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["unlinked", "ambiguous", "unavailable", "missing-login"])(
    "clears attribution on successive Slack follow-ups when current GitHub attribution is %s",
    async (scenario) => {
      const store = new AutomationStore(env.DB);
      const automationId = await seedSlackAutomation(store);
      await env.DB.prepare(
        `INSERT INTO user_identities
      (id, user_id, provider, provider_user_id, provider_login, provider_issuer, created_at, updated_at)
      VALUES ('actor-github', 'slack-actor-1', 'github', '42', 'reviewer', 'https://github.com', 1, 1)`
      ).run();
      const name = `slack-attribution-${crypto.randomUUID()}`;
      const { stub } = await initNamedSession(name, {
        repoOwner: null,
        repoName: null,
        repoId: null,
        userId: "user-1",
        canonicalUserId: "user-1",
      });
      const concurrencyKey = `slack:C1:${name}`;
      await seedRun(makeRunRow(automationId, { session_id: name, status: "running" }), {
        concurrencyKey,
      });
      await seedSandboxAuth(stub, { authToken: "slack-sandbox-token", sandboxId: name });
      const { ws: sandbox } = await openSandboxWs(name, {
        authToken: "slack-sandbox-token",
        sandboxId: name,
      });
      expect(sandbox).not.toBeNull();
      sandbox!.accept();
      try {
        sandbox!.send(
          JSON.stringify({ type: "ready", sandboxId: name, timestamp: Date.now() / 1000 })
        );
        await waitForSandboxStatus(stub, "ready");
        const firstCommands = collectMessages(sandbox!, {
          until: (message) => message.type === "prompt",
        });
        expect(
          await sendEvent(
            makeSlackEvent({ text: "first follow-up", concurrencyKey, threadTs: name })
          )
        ).toMatchObject({ steered: 1, triggered: 0 });
        const first = (await firstCommands).find((message) => message.type === "prompt");
        expect(first?.author).toEqual({
          userId: "slack:U1",
          gitIdentity: {
            mode: "attributed-user",
            name: "Integration User",
            email: "42+reviewer@users.noreply.github.com",
          },
        });
        if (scenario === "unlinked") {
          await env.DB.prepare("DELETE FROM user_identities WHERE id = 'actor-github'").run();
        } else if (scenario === "ambiguous") {
          await env.DB.prepare(
            `INSERT INTO user_identities
          (id, user_id, provider, provider_user_id, provider_login, provider_issuer, created_at, updated_at)
          VALUES ('actor-github-other', 'slack-actor-1', 'github', '43', 'other', 'https://github.com', 1, 1)`
          ).run();
        } else {
          await env.DB.prepare(
            "UPDATE user_identities SET provider_login = NULL WHERE id = 'actor-github'"
          ).run();
          if (scenario === "unavailable") {
            vi.spyOn(
              getUserAuth(createCloudflareEnv(env), env.DB).api,
              "getAccessToken"
            ).mockRejectedValue(new Error("Grant temporarily unavailable"));
          }
        }
        const secondCommands = collectMessages(sandbox!, {
          until: (message) => message.type === "prompt",
        });
        expect(
          await sendEvent(
            makeSlackEvent({ text: "second follow-up", concurrencyKey, threadTs: name })
          )
        ).toMatchObject({ steered: 1, triggered: 0 });
        sandbox!.send(
          JSON.stringify({
            type: "execution_complete",
            messageId: first!.messageId,
            success: true,
            sandboxId: name,
            timestamp: Date.now() / 1000,
          })
        );
        const second = (await secondCommands).find((message) => message.type === "prompt");
        expect(second?.author).toEqual({ userId: "slack:U1", gitIdentity: { mode: "agent-only" } });
        expect(await fetchRuns(automationId)).toHaveLength(1);
      } finally {
        await closeWebSocket(sandbox!, { bestEffort: true });
      }
    }
  );

  it.each([
    [
      "suspended",
      async () => {
        await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?")
          .bind("slack-actor-1")
          .run();
      },
    ],
    [
      "revoked",
      async () => {
        await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
          .bind("role_builtin_viewer", "slack-actor-1")
          .run();
      },
    ],
    [
      "missing collaboration permission",
      async () => {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO roles
            (id, key, name, normalized_name, description, is_system)
           VALUES ('role_no_collaboration', NULL, 'No Collaboration', 'no collaboration',
               NULL, 0)`
          ),
          env.DB.prepare(
            `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ('role_no_collaboration', 'sessions.create')`
          ),
          env.DB.prepare(
            "UPDATE user_role_assignments SET role_id = 'role_no_collaboration' WHERE user_id = 'slack-actor-1'"
          ),
        ]);
      },
    ],
  ])(
    "does not steer when the Slack actor's collaboration authority is %s",
    async (authorityState, revoke) => {
      const store = new AutomationStore(env.DB);
      const id = await seedSlackAutomation(store);
      const concurrencyKey = `slack:C1:thread-${authorityState}`;
      expect(
        await sendEvent(
          makeSlackEvent({
            text: "deploy the api",
            concurrencyKey,
            triggerKey: `slack:msg:C1:root-${authorityState}`,
          })
        )
      ).toMatchObject({ triggered: 1 });

      await revoke();

      expect(
        await sendEvent(
          makeSlackEvent({
            text: "also update the changelog",
            concurrencyKey,
            triggerKey: `slack:msg:C1:reply-${authorityState}`,
          })
        )
      ).toEqual({ triggered: 0, skipped: 1, steered: 0, invocationIds: [] });
      expect(await fetchRuns(id)).toHaveLength(1);
      expect(await fetchInvocations(store, id)).toHaveLength(1);
    }
  );

  it("does not impose automation-launch grants on the Slack actor while steering", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);
    const concurrencyKey = "slack:C1:thread-actor-only";
    const rootResult = await sendEvent(
      makeSlackEvent({
        text: "deploy the api",
        concurrencyKey,
        triggerKey: "slack:msg:C1:root-actor-only",
      })
    );
    expect(rootResult).toMatchObject({ triggered: 1 });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles
          (id, key, name, normalized_name, description, is_system)
         VALUES ('role_collaboration_only', NULL, 'Collaboration Only',
           'collaboration only', NULL, 0)`
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('role_collaboration_only', 'sessions.collaborate')`
      ),
      env.DB.prepare(
        `UPDATE user_role_assignments
         SET role_id = 'role_collaboration_only' WHERE user_id = 'slack-actor-1'`
      ),
    ]);

    expect(
      await sendEvent(
        makeSlackEvent({
          text: "also update the changelog",
          concurrencyKey,
          triggerKey: "slack:msg:C1:reply-actor-only",
        })
      )
    ).toEqual({ triggered: 0, skipped: 0, steered: 1, invocationIds: rootResult.invocationIds });
    expect(await fetchRuns(id)).toHaveLength(1);
  });

  it("continues the same session on a reply after the run has completed", async () => {
    const store = new AutomationStore(env.DB);
    const id = await seedSlackAutomation(store);

    const concurrencyKey = "slack:C1:thread-done";
    // Root message triggers the run and creates its session.
    const rootResult = await sendEvent(
      makeSlackEvent({
        text: "deploy the api",
        concurrencyKey,
        triggerKey: "slack:msg:C1:root-done",
      })
    );
    expect(rootResult.triggered).toBe(1);

    // Simulate the run finishing. Its session stays steerable within the window,
    // just like an @mention thread after a turn completes.
    const afterRoot = await fetchRuns(id);
    expect(afterRoot).toHaveLength(1);
    const rootRun = afterRoot[0]!;
    expect(rootRun.session_id).toBeTruthy();
    await store.updateRun(rootRun.id, { status: "completed", completed_at: Date.now() });

    // A reply after completion — with text that does NOT match the trigger
    // conditions — still continues the same session, proving the steer bypasses
    // both condition matching and the run-status filter.
    const followResult = await sendEvent(
      makeSlackEvent({
        text: "thanks! can you also bump the version?",
        concurrencyKey,
        triggerKey: "slack:msg:C1:reply-done",
      })
    );
    expect(followResult).toEqual({
      triggered: 0,
      skipped: 0,
      steered: 1,
      invocationIds: rootResult.invocationIds,
    });

    // The reply created no new run and recorded no skip — it reused the
    // completed run's session. Exactly one materialized run remains.
    const afterReply = await fetchRuns(id);
    expect(afterReply).toHaveLength(1);
    const invocations = await fetchInvocations(store, id);
    expect(
      invocations.find((invocation) => invocation.skipReason === "concurrent_run_active")
    ).toBeUndefined();
    expect(invocations).toHaveLength(1);

    // The follow-up queues another spawn after the first stubbed attempt fails.
    // Keep it inside the test's lifetime, just like the init warming attempt.
    await waitForSandboxStatus(
      env.SESSION.get(env.SESSION.idFromName(rootRun.session_id!)),
      "failed"
    );
  });
});
