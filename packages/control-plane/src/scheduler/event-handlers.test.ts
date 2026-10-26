import { describe, expect, it, vi } from "vitest";
import {
  normalizeWebhookEvent,
  type LinearAutomationEvent,
  type SentryAutomationEvent,
  type SlackAutomationEvent,
} from "@open-inspect/shared/triggers";
import type { AutomationRow, AutomationRunRow } from "../db/automation-store";
import { createLogger } from "../logger";
import { AutomationEventHandler, type AutomationEventHandlerDeps } from "./event-handler";
import { SlackContinuationPolicyFactory } from "./slack-continuation-policy";
import { WebhookContinuationPolicyFactory } from "./webhook-continuation-policy";
import type { ContinuationPolicy, SteeringActor } from "./session-continuity";
import { SessionFollowUpRefusedError } from "./contracts";
import { SlackEventHandler, type SlackEventHandlerDeps } from "./slack-event-handler";
import { WebhookEventHandler, type WebhookEventHandlerDeps } from "./webhook-event-handler";
import { DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS } from "@open-inspect/shared/types/automations";

const automation: AutomationRow = {
  id: "auto-1",
  name: "Event agent",
  instructions: "Run tests",
  trigger_type: "webhook",
  schedule_cron: null,
  schedule_once_at: null,
  schedule_tz: "UTC",
  harness: "codex",
  model: "openai/gpt-5.4",
  reasoning_effort: null,
  enabled: 1,
  max_concurrent_runs: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
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
  };
  return {
    ...deps,
    policies: new SlackContinuationPolicyFactory(deps),
  } satisfies SlackEventHandlerDeps;
}

describe("Slack event ownership", () => {
  it("accepts an injected factory returning only the public policy contract", async () => {
    const deps = slackHarness();
    const policy: ContinuationPolicy = {
      source: "slack",
      resolveActor: vi.fn(),
      buildPrompt: vi.fn(),
    };
    const policies = { create: vi.fn(() => policy) };
    const handler = new SlackEventHandler({ ...deps, policies });

    await handler.handle(slackEvent);

    expect(policies.create).toHaveBeenCalledExactlyOnceWith(slackEvent);
    expect(deps.continuity.continueSession).toHaveBeenCalledTimes(2);
    for (const call of deps.continuity.continueSession.mock.calls) {
      expect(call[3]).toBe(policy);
    }
  });

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
  const deps = {
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
  };
  return {
    ...deps,
    policies: new WebhookContinuationPolicyFactory(deps),
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
  it("accepts an injected factory returning only the public policy contract", async () => {
    const deps = webhookHarness();
    const policy: ContinuationPolicy = {
      source: "webhook",
      resolveActor: vi.fn(),
      buildPrompt: vi.fn(),
    };
    const policies = { create: vi.fn(async () => policy) };
    const handler = new WebhookEventHandler({ ...deps, policies });

    await handler.handle(webhookEvent);

    expect(policies.create).toHaveBeenCalledExactlyOnceWith(
      webhookEvent,
      automation,
      { claimId: "id-1", invocationId: "id-2" },
      "webhook:hashed-key"
    );
    expect(deps.continuity.continueSession).toHaveBeenCalledExactlyOnceWith(
      automation,
      webhookEvent.concurrencyKey,
      100,
      policy
    );
  });

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

const actor = {
  userId: "slack-user",
  authorId: "slack:U1",
  context: {} as SteeringActor["context"],
} satisfies SteeringActor;
const continuationRun: AutomationRunRow = {
  id: "run-1",
  automation_id: automation.id,
  invocation_id: "existing-invocation",
  session_id: "session-1",
  status: "running",
  skip_reason: null,
  failure_reason: null,
  scheduled_at: 0,
  started_at: 0,
  completed_at: null,
  execution_deadline_at: null,
  created_at: 0,
  repo_owner: "acme",
  repo_name: "api",
  repo_id: 1,
  base_branch: "main",
  environment_id: null,
  first_prompt_pending: 0,
};

describe("Slack continuation policy", () => {
  it("defers actor reads and shares concurrent resolution only within the delivery", async () => {
    const deps = slackHarness();
    deps.continuity.resolveActor.mockResolvedValue(actor);
    const policy = deps.policies.create(slackEvent);
    expect(deps.users.getIdentity).not.toHaveBeenCalled();
    expect(deps.continuity.resolveActor).not.toHaveBeenCalled();
    await expect(Promise.all([policy.resolveActor(), policy.resolveActor()])).resolves.toEqual([
      actor,
      actor,
    ]);
    expect(deps.users.getIdentity).toHaveBeenCalledExactlyOnceWith("slack", "U1");
    expect(deps.continuity.resolveActor).toHaveBeenCalledExactlyOnceWith(
      { userId: "slack-user", authorId: "slack:U1" },
      `automation:slack-steering:${slackEvent.triggerKey}`,
      slackEvent.triggerKey
    );
    await deps.policies.create(slackEvent).resolveActor();
    expect(deps.users.getIdentity).toHaveBeenCalledTimes(2);
  });

  it("caches an absent Slack identity without resolving authorization", async () => {
    const deps = slackHarness();
    deps.users.getIdentity.mockResolvedValue(null);
    const policy = deps.policies.create(slackEvent);
    await expect(policy.resolveActor()).resolves.toBeNull();
    await expect(policy.resolveActor()).resolves.toBeNull();
    expect(deps.users.getIdentity).toHaveBeenCalledTimes(1);
    expect(deps.continuity.resolveActor).not.toHaveBeenCalled();
  });

  it("retains a rejected actor lookup for the delivery and retries on the next delivery", async () => {
    const deps = slackHarness();
    const error = new Error("Authorization unavailable");
    deps.continuity.resolveActor.mockRejectedValueOnce(error).mockResolvedValue(actor);
    const policy = deps.policies.create(slackEvent);
    await expect(policy.resolveActor()).rejects.toBe(error);
    await expect(policy.resolveActor()).rejects.toBe(error);
    expect(deps.continuity.resolveActor).toHaveBeenCalledTimes(1);
    await expect(deps.policies.create(slackEvent).resolveActor()).resolves.toBe(actor);
    expect(deps.users.getIdentity).toHaveBeenCalledTimes(2);
  });

  it("keeps prompt metadata specific to each automation sharing a delivery", async () => {
    const deps = slackHarness();
    const enrichment = {
      scmUserId: "42",
      scmLogin: "octo",
      displayName: "Octo",
      email: "o@example.com",
    };
    deps.attribution.resolve.mockResolvedValue(enrichment);
    const policy = deps.policies.create(slackEvent);
    const other = { ...automation, id: "auto-2", model: "other-model", reasoning_effort: "high" };
    for (const row of [automation, other]) {
      const prompt = await policy.buildPrompt(continuationRun, actor, row);
      expect(prompt).toEqual({
        body: {
          content: slackEvent.text,
          authorId: actor.authorId,
          canonicalUserId: actor.userId,
          scmEnrichment: { userId: "42", login: "octo", name: "Octo", email: "o@example.com" },
          source: "slack",
          callbackContext: {
            source: "slack",
            channel: "C1",
            threadTs: "1",
            reactionMessageTs: "2",
            repoFullName: "acme/api",
            model: row.model,
            reasoningEffort: row.reasoning_effort ?? undefined,
            automationId: row.id,
          },
        },
        ctx: { trace_id: `automation:${row.id}`, request_id: "slack:C1:2" },
      });
    }
    expect(deps.attribution.resolve).toHaveBeenCalledTimes(2);
    expect(deps.users.getIdentity).not.toHaveBeenCalled();
  });

  it.each(["github", "gitlab"] as const)(
    "preserves optional attribution for %s",
    async (scmProvider) => {
      const deps = slackHarness();
      const policy = new SlackContinuationPolicyFactory({ ...deps, scmProvider }).create({
        ...slackEvent,
        threadTs: undefined,
      });
      const { body } = await policy.buildPrompt(continuationRun, actor, automation);
      expect(body.scmEnrichment).toEqual(
        scmProvider === "github"
          ? { userId: null, login: null, name: null, email: null }
          : undefined
      );
      expect(body.callbackContext).toMatchObject({ threadTs: "2" });
    }
  );
});

describe("Webhook continuation policy", () => {
  it("reuses a reconciled request ID and resolves the current owner only when needed", async () => {
    const deps = webhookHarness();
    deps.store.resolveCanonicalOwner.mockResolvedValue({
      user_id: "current-owner",
      created_by: "current-author",
    });
    deps.continuity.resolveActor.mockResolvedValue(actor);
    const policy = await deps.policies.create(webhookEvent, automation, null, "webhook:reconciled");
    expect(deps.crypto.hashToken).not.toHaveBeenCalled();
    expect(deps.store.resolveCanonicalOwner).not.toHaveBeenCalled();
    await expect(policy.resolveActor()).resolves.toBe(actor);
    expect(deps.continuity.resolveActor).toHaveBeenCalledWith(
      { userId: "current-owner", authorId: "current-author" },
      `automation:webhook-steering:${webhookEvent.triggerKey}`,
      webhookEvent.triggerKey
    );
    const { body, ctx } = await policy.buildPrompt(continuationRun, actor, automation);
    expect(body).toMatchObject({
      clientRequestId: "webhook:reconciled",
      source: "automation",
      authorId: actor.authorId,
      canonicalUserId: actor.userId,
    });
    expect(body.content).toContain(webhookEvent.contextBlock);
    expect(body.callbackContext).toBeUndefined();
    expect(ctx).toEqual({
      trace_id: `automation:${automation.id}`,
      request_id: webhookEvent.triggerKey,
    });
  });

  it("hashes a missing request ID without reading the owner or touching a receipt", async () => {
    const deps = webhookHarness();
    const policy = await deps.policies.create(webhookEvent, automation, null, null);
    expect(deps.crypto.hashToken).toHaveBeenCalledExactlyOnceWith(webhookEvent.triggerKey);
    await expect(policy.buildPrompt(continuationRun, actor, automation)).resolves.toMatchObject({
      body: { clientRequestId: "webhook:hashed-key" },
    });
    await policy.acceptDelivery!(continuationRun);
    await policy.releaseDelivery!();
    expect(deps.store.resolveCanonicalOwner).not.toHaveBeenCalled();
    expect(deps.store.acceptFollowUpReceipt).not.toHaveBeenCalled();
    expect(deps.store.releaseFollowUpReceipt).not.toHaveBeenCalled();
  });

  it("settles the bound claim using the continued invocation and current time", async () => {
    const deps = webhookHarness();
    const policy = await deps.policies.create(
      webhookEvent,
      automation,
      { claimId: "claim-1", invocationId: "reserved-invocation" },
      "webhook:reconciled"
    );
    deps.clock.now = () => 200;
    await policy.acceptDelivery!(continuationRun);
    expect(deps.store.acceptFollowUpReceipt).toHaveBeenCalledExactlyOnceWith(
      automation.id,
      webhookEvent.triggerKey,
      "claim-1",
      "existing-invocation",
      200
    );
    await policy.releaseDelivery!();
    expect(deps.store.releaseFollowUpReceipt).toHaveBeenCalledExactlyOnceWith(
      automation.id,
      webhookEvent.triggerKey,
      "claim-1"
    );
  });

  it("does not resolve an actor when the automation no longer has a canonical user", async () => {
    const deps = webhookHarness();
    deps.store.resolveCanonicalOwner.mockResolvedValue({ user_id: null });
    const policy = await deps.policies.create(webhookEvent, automation, null, "webhook:reconciled");
    await expect(policy.resolveActor()).resolves.toBeNull();
    expect(deps.continuity.resolveActor).not.toHaveBeenCalled();
  });
});
