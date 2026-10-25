import { describe, expect, it, vi } from "vitest";
import {
  normalizeWebhookEvent,
  type LinearAutomationEvent,
  type SentryAutomationEvent,
  type SlackAutomationEvent,
} from "@open-inspect/shared/triggers";
import type { AutomationRow } from "../db/automation-store";
import { createLogger } from "../logger";
import { AutomationEventHandler, type AutomationEventHandlerDeps } from "./event-handler";
import { SessionFollowUpRefusedError } from "./contracts";
import { SlackEventHandler, type SlackEventHandlerDeps } from "./slack-event-handler";
import { WebhookEventHandler, type WebhookEventHandlerDeps } from "./webhook-event-handler";

const automation: AutomationRow = {
  id: "auto-1",
  name: "Event agent",
  instructions: "Run tests",
  trigger_type: "webhook",
  schedule_cron: null,
  schedule_tz: "UTC",
  harness: "codex",
  model: "openai/gpt-5.4",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: null,
  consecutive_failures: 0,
  created_by: "author-1",
  user_id: "user-1",
  owner_team_id: null,
  max_retries: 0,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
  event_type: null,
  trigger_config: '{"conditions":[]}',
  trigger_auth_data: null,
};
const log = createLogger("event-handlers-test", {}, "error");
const slackEvent: SlackAutomationEvent = {
  source: "slack",
  eventType: "message.posted",
  triggerKey: "slack:msg:C1:2",
  concurrencyKey: "slack:C1:1",
  contextBlock: "Message context",
  meta: {},
  channelId: "C1",
  permalink: "https://example.slack.com/archives/C1/p2",
  threadTs: "1",
  ts: "2",
  actorUserId: "U1",
  text: "please deploy",
};

function slackHarness() {
  const deps = {
    channels: {
      getSlackAutomationsForChannel: vi.fn().mockResolvedValue([
        { ...automation, trigger_type: "slack_event", event_type: "message.posted" },
        { ...automation, id: "auto-2", trigger_type: "slack_event", event_type: "message.posted" },
      ]),
    },
    slack: {
      getSessionInstructions: vi.fn().mockResolvedValue("Workspace instructions"),
      contextWithThread: vi.fn().mockResolvedValue("Thread context"),
      notifySkip: vi.fn().mockResolvedValue(undefined),
    },
    invocations: {
      start: vi
        .fn<SlackEventHandlerDeps["invocations"]["start"]>()
        .mockImplementation(async (input) => {
          await input.instructionsOverrideFactory?.();
          return { outcome: "started", invocationId: input.automation.id, runs: [], launched: 1 };
        }),
    },
    continuity: {
      continueSession: vi
        .fn<SlackEventHandlerDeps["continuity"]["continueSession"]>()
        .mockResolvedValue({ kind: "fall_through" }),
      resolveActor: vi.fn().mockResolvedValue(null),
    },
    users: { getIdentity: vi.fn().mockResolvedValue({ userId: "slack-user" }) },
    attribution: { resolve: vi.fn().mockResolvedValue(null) },
    scmProvider: "github" as const,
    clock: { now: () => 100 },
    log,
  } satisfies SlackEventHandlerDeps;
  return deps;
}

describe("Slack event ownership", () => {
  it("shares lazy context and settings within a delivery, then reads them again for the next", async () => {
    const deps = slackHarness();
    const handler = new SlackEventHandler(deps);
    await expect(handler.handle(slackEvent)).resolves.toMatchObject({ triggered: 2 });
    expect(deps.slack.contextWithThread).toHaveBeenCalledTimes(1);
    expect(deps.slack.getSessionInstructions).toHaveBeenCalledTimes(1);
    await handler.handle({ ...slackEvent, triggerKey: "slack:msg:C1:3", ts: "3" });
    expect(deps.slack.contextWithThread).toHaveBeenCalledTimes(2);
    expect(deps.slack.getSessionInstructions).toHaveBeenCalledTimes(2);
  });

  it("shares actor lookup within a delivery while checking continuation separately for every target", async () => {
    const deps = slackHarness();
    const handler = new SlackEventHandler(deps);
    deps.continuity.continueSession.mockImplementation(async (row, _key, _now, policy) => {
      await policy.resolveActor();
      return { kind: "steered", invocationId: row.id };
    });
    // Invalid conditions must not prevent a reply from continuing its session.
    deps.channels.getSlackAutomationsForChannel.mockResolvedValue([
      { ...automation, id: "auto-1", trigger_config: "invalid" },
      { ...automation, id: "auto-2", trigger_config: "invalid" },
    ]);
    await expect(handler.handle(slackEvent)).resolves.toEqual({
      triggered: 0,
      skipped: 0,
      steered: 2,
      invocationIds: ["auto-1", "auto-2"],
    });
    expect(deps.continuity.continueSession).toHaveBeenCalledTimes(2);
    expect(deps.continuity.resolveActor).toHaveBeenCalledTimes(1);
    expect(deps.users.getIdentity).toHaveBeenCalledTimes(1);
    expect(deps.invocations.start).not.toHaveBeenCalled();
    expect(deps.slack.getSessionInstructions).not.toHaveBeenCalled();
    await handler.handle(slackEvent);
    expect(deps.continuity.resolveActor).toHaveBeenCalledTimes(2);
    expect(deps.users.getIdentity).toHaveBeenCalledTimes(2);
  });

  it("publishes one concurrency notice without reading context when all admissions skip", async () => {
    const deps = slackHarness();
    const handler = new SlackEventHandler(deps);
    deps.invocations.start.mockResolvedValue({ outcome: "skipped", invocationId: null });
    await expect(handler.handle(slackEvent)).resolves.toMatchObject({ skipped: 2 });
    expect(deps.slack.notifySkip).toHaveBeenCalledExactlyOnceWith(slackEvent);
    expect(deps.slack.contextWithThread).not.toHaveBeenCalled();
  });
});

function webhookHarness() {
  let id = 0;
  return {
    store: {
      getById: vi.fn().mockResolvedValue(automation),
      getInvocationIdByTriggerKey: vi.fn().mockResolvedValue(null),
      claimFollowUpReceipt: vi.fn().mockResolvedValue({ kind: "claimed" }),
      acceptFollowUpReceipt: vi.fn().mockResolvedValue(undefined),
      releaseFollowUpReceipt: vi.fn().mockResolvedValue(undefined),
      resolveCanonicalOwner: vi.fn().mockResolvedValue(automation),
    },
    invocations: {
      start: vi
        .fn<WebhookEventHandlerDeps["invocations"]["start"]>()
        .mockResolvedValue({ outcome: "blocked", reason: "concurrent_run_active" }),
    },
    continuity: {
      continueSession: vi
        .fn<WebhookEventHandlerDeps["continuity"]["continueSession"]>()
        .mockResolvedValue({ kind: "fall_through" }),
      findHistoricalPromptReceipt: vi
        .fn<WebhookEventHandlerDeps["continuity"]["findHistoricalPromptReceipt"]>()
        .mockResolvedValue({ kind: "fall_through" }),
      resolveActor: vi.fn().mockResolvedValue(null),
    },
    crypto: { hashToken: vi.fn().mockResolvedValue("hashed-key"), generateId: () => `id-${++id}` },
    clock: { now: () => 100 },
    log,
  } satisfies WebhookEventHandlerDeps;
}
const webhookEvent = normalizeWebhookEvent(
  automation.id,
  { mode: "stop" },
  {
    idempotencyKey: "delivery",
    sessionKey: "session",
  }
);

describe("Webhook receipt ownership", () => {
  it("reconciles a historical receipt before parsing changed conditions", async () => {
    const deps = webhookHarness();
    const handler = new WebhookEventHandler(deps);
    deps.store.getById.mockResolvedValue({ ...automation, trigger_config: "invalid" });
    deps.continuity.findHistoricalPromptReceipt.mockResolvedValue({
      kind: "skipped",
      invocationId: "original",
    });
    await expect(handler.handle(webhookEvent)).resolves.toEqual({
      triggered: 0,
      skipped: 1,
      steered: 0,
      invocationIds: ["original"],
    });
    expect(deps.store.acceptFollowUpReceipt).toHaveBeenCalledWith(
      automation.id,
      webhookEvent.triggerKey,
      "id-1",
      "original",
      100
    );
    expect(deps.store.releaseFollowUpReceipt).not.toHaveBeenCalled();
    expect(deps.continuity.continueSession).not.toHaveBeenCalled();
    expect(deps.invocations.start).not.toHaveBeenCalled();
  });

  it("releases a claim when conditions reject a new delivery before attempting continuation", async () => {
    const deps = webhookHarness();
    const handler = new WebhookEventHandler(deps);
    deps.store.getById.mockResolvedValue({
      ...automation,
      trigger_config: JSON.stringify({
        conditions: [
          {
            type: "jsonpath",
            operator: "all_match",
            value: [{ path: "$.mode", comparison: "eq", value: "iterate" }],
          },
        ],
      }),
    });
    await expect(handler.handle(webhookEvent)).resolves.toMatchObject({
      triggered: 0,
      skipped: 0,
      steered: 0,
    });
    expect(deps.store.releaseFollowUpReceipt).toHaveBeenCalledWith(
      automation.id,
      webhookEvent.triggerKey,
      "id-1"
    );
    expect(deps.continuity.continueSession).not.toHaveBeenCalled();
    expect(deps.invocations.start).not.toHaveBeenCalled();
  });

  it.each(["history", "continuation"] as const)(
    "retains the lease when %s cannot confirm delivery",
    async (stage) => {
      const deps = webhookHarness();
      const handler = new WebhookEventHandler(deps);
      const refused = {
        kind: "refused" as const,
        invocationId: "original",
        status: null,
        code: null,
      };
      if (stage === "history")
        deps.continuity.findHistoricalPromptReceipt.mockResolvedValue(refused);
      else deps.continuity.continueSession.mockResolvedValue(refused);
      await expect(handler.handle(webhookEvent)).rejects.toBeInstanceOf(
        SessionFollowUpRefusedError
      );
      expect(deps.store.releaseFollowUpReceipt).not.toHaveBeenCalled();
      expect(deps.store.acceptFollowUpReceipt).not.toHaveBeenCalled();
      expect(deps.invocations.start).not.toHaveBeenCalled();
    }
  );

  it("hands the claimed identity to initial admission without accepting the receipt a second time", async () => {
    const deps = webhookHarness();
    const handler = new WebhookEventHandler(deps);
    deps.invocations.start.mockResolvedValue({
      outcome: "started",
      invocationId: "id-2",
      runs: [],
      launched: 1,
    });
    await expect(handler.handle(webhookEvent)).resolves.toMatchObject({
      triggered: 1,
      invocationIds: ["id-2"],
    });
    expect(deps.invocations.start).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: "id-2",
        webhookFollowUpClaimId: "id-1",
        triggerKey: webhookEvent.triggerKey,
      })
    );
    expect(deps.store.acceptFollowUpReceipt).not.toHaveBeenCalled();
    expect(deps.store.releaseFollowUpReceipt).not.toHaveBeenCalled();
  });
});

function eventHandlerHarness() {
  const deps = {
    store: {
      getById: vi.fn<AutomationEventHandlerDeps["store"]["getById"]>(),
      getAutomationsForEvent:
        vi.fn<AutomationEventHandlerDeps["store"]["getAutomationsForEvent"]>(),
    },
    invocations: {
      start: vi.fn<AutomationEventHandlerDeps["invocations"]["start"]>().mockResolvedValue({
        outcome: "started",
        invocationId: "inv-1",
        runs: [],
        launched: 1,
      }),
    },
    admitGitHubEvent: vi.fn<AutomationEventHandlerDeps["admitGitHubEvent"]>(),
    slack: { handle: vi.fn<SlackEventHandler["handle"]>() },
    webhook: { handle: vi.fn<WebhookEventHandler["handle"]>() },
    log,
  } satisfies AutomationEventHandlerDeps;
  return { deps, handler: new AutomationEventHandler(deps) };
}

const linearEvent: LinearAutomationEvent = {
  source: "linear",
  eventType: "issue.created",
  repoOwner: "acme",
  repoName: "api",
  triggerKey: "linear:delivery-1",
  concurrencyKey: "linear:issue-1",
  contextBlock: "Linear issue context",
  meta: {},
  linearStatus: "Todo",
};
const sentryEvent: SentryAutomationEvent = {
  source: "sentry",
  eventType: "issue.created",
  automationId: automation.id,
  triggerKey: "sentry:delivery-1",
  concurrencyKey: "sentry:issue-1",
  contextBlock: "Sentry issue context",
  meta: {},
  sentryProject: "backend",
  sentryLevel: "error",
};
const sentryAutomation: AutomationRow = {
  ...automation,
  trigger_type: "sentry",
  event_type: sentryEvent.eventType,
  trigger_config: JSON.stringify({
    conditions: [{ type: "sentry_project", operator: "any_of", value: ["backend"] }],
  }),
};

describe("AutomationEventHandler source dispatch", () => {
  it("looks up Linear candidates by repository and event type, admitting only condition matches", async () => {
    const { deps, handler } = eventHandlerHarness();
    const matching = {
      ...automation,
      trigger_type: "linear_event",
      event_type: linearEvent.eventType,
      trigger_config: JSON.stringify({
        conditions: [{ type: "linear_status", operator: "any_of", value: ["Todo"] }],
      }),
    };
    deps.store.getAutomationsForEvent.mockResolvedValue([
      {
        ...matching,
        id: "unmatched",
        trigger_config: JSON.stringify({
          conditions: [{ type: "linear_status", operator: "any_of", value: ["Done"] }],
        }),
      },
      matching,
    ]);

    await expect(handler.handle(linearEvent)).resolves.toEqual({
      triggered: 1,
      skipped: 0,
      steered: 0,
      invocationIds: ["inv-1"],
    });
    expect(deps.store.getAutomationsForEvent).toHaveBeenCalledExactlyOnceWith(
      "acme",
      "api",
      "linear_event",
      "issue.created"
    );
    expect(deps.store.getById).not.toHaveBeenCalled();
    expect(deps.invocations.start).toHaveBeenCalledExactlyOnceWith({
      automation: matching,
      source: "event",
      triggerKey: linearEvent.triggerKey,
      concurrencyKey: linearEvent.concurrencyKey,
      triggerMetadata: null,
      instructionsOverride: expect.stringContaining(linearEvent.contextBlock),
    });
  });

  it.each([
    { name: "missing", candidate: null },
    { name: "disabled", candidate: { ...sentryAutomation, enabled: 0 } },
    { name: "deleted", candidate: { ...sentryAutomation, deleted_at: 100 } },
    { name: "wrong event type", candidate: { ...sentryAutomation, event_type: "issue.resolved" } },
  ])("does not admit a Sentry automation that is $name", async ({ candidate }) => {
    const { deps, handler } = eventHandlerHarness();
    deps.store.getById.mockResolvedValue(candidate);

    await expect(handler.handle(sentryEvent)).resolves.toEqual({
      triggered: 0,
      skipped: 0,
      steered: 0,
      invocationIds: [],
    });
    expect(deps.store.getById).toHaveBeenCalledExactlyOnceWith(automation.id);
    expect(deps.store.getAutomationsForEvent).not.toHaveBeenCalled();
    expect(deps.invocations.start).not.toHaveBeenCalled();
  });

  it.each([
    { project: "backend", admitted: true },
    { project: "frontend", admitted: false },
  ])("gates Sentry admission on project conditions: $project", async ({ project, admitted }) => {
    const { deps, handler } = eventHandlerHarness();
    deps.store.getById.mockResolvedValue(sentryAutomation);
    const event = { ...sentryEvent, sentryProject: project };

    await expect(handler.handle(event)).resolves.toEqual({
      triggered: admitted ? 1 : 0,
      skipped: 0,
      steered: 0,
      invocationIds: admitted ? ["inv-1"] : [],
    });
    expect(deps.store.getById).toHaveBeenCalledExactlyOnceWith(automation.id);
    expect(deps.store.getAutomationsForEvent).not.toHaveBeenCalled();
    if (admitted) {
      expect(deps.invocations.start).toHaveBeenCalledExactlyOnceWith({
        automation: sentryAutomation,
        source: "event",
        triggerKey: event.triggerKey,
        concurrencyKey: event.concurrencyKey,
        triggerMetadata: null,
        instructionsOverride: expect.stringContaining(event.contextBlock),
      });
    } else {
      expect(deps.invocations.start).not.toHaveBeenCalled();
    }
  });
});
