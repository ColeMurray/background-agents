import { describe, expect, it, vi } from "vitest";
import { normalizeWebhookEvent, type SlackAutomationEvent } from "@open-inspect/shared/triggers";
import type { AutomationRow } from "../db/automation-store";
import { createLogger } from "../logger";
import { SessionFollowUpRefusedError } from "./contracts";
import { handleSlackEvent, type SlackEventDeps } from "./slack-events";
import { handleWebhookEvent, type WebhookEventDeps } from "./webhook-events";

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
      start: vi.fn<SlackEventDeps["invocations"]["start"]>().mockImplementation(async (input) => {
        await input.instructionsOverrideFactory?.();
        return { outcome: "started", invocationId: input.automation.id, runs: [], launched: 1 };
      }),
    },
    continueSession: vi
      .fn<SlackEventDeps["continueSession"]>()
      .mockResolvedValue({ kind: "fall_through" }),
    resolveActor: vi.fn().mockResolvedValue(null),
    resolveScmEnrichment: vi.fn().mockResolvedValue(null),
    scmProvider: () => "github" as const,
    nowMs: () => 100,
    log,
  } satisfies SlackEventDeps;
  return deps;
}

describe("Slack event ownership", () => {
  it("shares lazy context and settings within a delivery, then reads them again for the next", async () => {
    const deps = slackHarness();
    await expect(handleSlackEvent(slackEvent, deps)).resolves.toMatchObject({ triggered: 2 });
    expect(deps.slack.contextWithThread).toHaveBeenCalledTimes(1);
    expect(deps.slack.getSessionInstructions).toHaveBeenCalledTimes(1);
    await handleSlackEvent({ ...slackEvent, triggerKey: "slack:msg:C1:3", ts: "3" }, deps);
    expect(deps.slack.contextWithThread).toHaveBeenCalledTimes(2);
    expect(deps.slack.getSessionInstructions).toHaveBeenCalledTimes(2);
  });

  it("shares actor lookup within a delivery while checking continuation separately for every target", async () => {
    const deps = slackHarness();
    deps.continueSession.mockImplementation(async (row, _key, _now, policy) => {
      await policy.resolveActor();
      return { kind: "steered", invocationId: row.id };
    });
    // Invalid conditions must not prevent a reply from continuing its session.
    deps.channels.getSlackAutomationsForChannel.mockResolvedValue([
      { ...automation, id: "auto-1", trigger_config: "invalid" },
      { ...automation, id: "auto-2", trigger_config: "invalid" },
    ]);
    await expect(handleSlackEvent(slackEvent, deps)).resolves.toEqual({
      triggered: 0,
      skipped: 0,
      steered: 2,
      invocationIds: ["auto-1", "auto-2"],
    });
    expect(deps.continueSession).toHaveBeenCalledTimes(2);
    expect(deps.resolveActor).toHaveBeenCalledTimes(1);
    expect(deps.invocations.start).not.toHaveBeenCalled();
    expect(deps.slack.getSessionInstructions).not.toHaveBeenCalled();
    await handleSlackEvent(slackEvent, deps);
    expect(deps.resolveActor).toHaveBeenCalledTimes(2);
  });

  it("publishes one concurrency notice without reading context when all admissions skip", async () => {
    const deps = slackHarness();
    deps.invocations.start.mockResolvedValue({ outcome: "skipped", invocationId: null });
    await expect(handleSlackEvent(slackEvent, deps)).resolves.toMatchObject({ skipped: 2 });
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
        .fn<WebhookEventDeps["invocations"]["start"]>()
        .mockResolvedValue({ outcome: "blocked", reason: "concurrent_run_active" }),
    },
    continueSession: vi
      .fn<WebhookEventDeps["continueSession"]>()
      .mockResolvedValue({ kind: "fall_through" }),
    findHistoricalPromptReceipt: vi
      .fn<WebhookEventDeps["findHistoricalPromptReceipt"]>()
      .mockResolvedValue({ kind: "fall_through" }),
    resolveActor: vi.fn().mockResolvedValue(null),
    hashToken: vi.fn().mockResolvedValue("hashed-key"),
    nowMs: () => 100,
    newId: () => `id-${++id}`,
    log,
  } satisfies WebhookEventDeps;
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
    deps.store.getById.mockResolvedValue({ ...automation, trigger_config: "invalid" });
    deps.findHistoricalPromptReceipt.mockResolvedValue({
      kind: "skipped",
      invocationId: "original",
    });
    await expect(handleWebhookEvent(webhookEvent, deps)).resolves.toEqual({
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
    expect(deps.continueSession).not.toHaveBeenCalled();
    expect(deps.invocations.start).not.toHaveBeenCalled();
  });

  it("releases a claim when conditions reject a new delivery before attempting continuation", async () => {
    const deps = webhookHarness();
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
    await expect(handleWebhookEvent(webhookEvent, deps)).resolves.toMatchObject({
      triggered: 0,
      skipped: 0,
      steered: 0,
    });
    expect(deps.store.releaseFollowUpReceipt).toHaveBeenCalledWith(
      automation.id,
      webhookEvent.triggerKey,
      "id-1"
    );
    expect(deps.continueSession).not.toHaveBeenCalled();
    expect(deps.invocations.start).not.toHaveBeenCalled();
  });

  it.each(["history", "continuation"] as const)(
    "retains the lease when %s cannot confirm delivery",
    async (stage) => {
      const deps = webhookHarness();
      const refused = {
        kind: "refused" as const,
        invocationId: "original",
        status: null,
        code: null,
      };
      if (stage === "history") deps.findHistoricalPromptReceipt.mockResolvedValue(refused);
      else deps.continueSession.mockResolvedValue(refused);
      await expect(handleWebhookEvent(webhookEvent, deps)).rejects.toBeInstanceOf(
        SessionFollowUpRefusedError
      );
      expect(deps.store.releaseFollowUpReceipt).not.toHaveBeenCalled();
      expect(deps.store.acceptFollowUpReceipt).not.toHaveBeenCalled();
      expect(deps.invocations.start).not.toHaveBeenCalled();
    }
  );

  it("hands the claimed identity to initial admission without accepting the receipt a second time", async () => {
    const deps = webhookHarness();
    deps.invocations.start.mockResolvedValue({
      outcome: "started",
      invocationId: "id-2",
      runs: [],
      launched: 1,
    });
    await expect(handleWebhookEvent(webhookEvent, deps)).resolves.toMatchObject({
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
