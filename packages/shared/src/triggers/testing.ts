/**
 * Test helpers for trigger source modules.
 */

import type {
  AutomationEvent,
  AutomationEventSource,
  SentryAutomationEvent,
  WebhookAutomationEvent,
  GitHubAutomationEvent,
  LinearAutomationEvent,
} from "./types";
import type { TriggerCondition } from "./conditions";
import { matchesConditions } from "./conditions";
import { conditionRegistry } from "./registry";
import type { Automation } from "../types";

type EventForSource<S extends AutomationEventSource> = Extract<AutomationEvent, { source: S }>;

const defaults: Record<AutomationEventSource, () => AutomationEvent> = {
  github: () =>
    ({
      source: "github",
      eventType: "pull_request.opened",
      triggerKey: "pr:1",
      concurrencyKey: "pr:1",
      contextBlock: "Test GitHub context",
      meta: {},
      repoOwner: "test-owner",
      repoName: "test-repo",
    }) as GitHubAutomationEvent,
  linear: () =>
    ({
      source: "linear",
      eventType: "issue.created",
      triggerKey: "linear_issue:abc",
      concurrencyKey: "linear_issue:abc",
      contextBlock: "Test Linear context",
      meta: {},
      repoOwner: "test-owner",
      repoName: "test-repo",
    }) as LinearAutomationEvent,
  sentry: () =>
    ({
      source: "sentry",
      eventType: "issue.created",
      triggerKey: "sentry_issue:123",
      concurrencyKey: "sentry_issue:123",
      contextBlock: "Test Sentry context",
      meta: {},
      sentryProject: "test-project",
      sentryLevel: "error",
    }) as SentryAutomationEvent,
  webhook: () =>
    ({
      source: "webhook",
      eventType: "webhook.received",
      triggerKey: "webhook:delivery-1",
      concurrencyKey: "webhook:delivery-1",
      contextBlock: "Test webhook context",
      meta: {},
      automationId: "auto-1",
      body: {},
    }) as WebhookAutomationEvent,
};

/**
 * Build a mock event for testing. Source-specific fields are typed.
 */
export function buildMockEvent<S extends AutomationEventSource>(
  source: S,
  overrides?: Partial<EventForSource<S>>
): EventForSource<S> {
  return { ...defaults[source](), ...overrides } as EventForSource<S>;
}

/**
 * Assert a condition matches (or doesn't) against a given event.
 */
export function assertConditionMatch(
  condition: TriggerCondition,
  event: AutomationEvent,
  expected: boolean
): void {
  const result = matchesConditions([condition], event, conditionRegistry);
  if (result !== expected) {
    throw new Error(
      `Expected condition ${condition.type}/${condition.operator} to ${expected ? "match" : "not match"}, but got ${result}`
    );
  }
}

/**
 * Build a minimal trigger automation for testing.
 */
export function makeTriggerAutomation(overrides?: Partial<Automation>): Automation {
  return {
    id: "auto-test",
    name: "Test Automation",
    repoOwner: "test-owner",
    repoName: "test-repo",
    baseBranch: "main",
    repoId: 1,
    instructions: "Test instructions",
    triggerType: "sentry",
    scheduleCron: null,
    scheduleTz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    enabled: true,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdBy: "test-user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    eventType: "issue.created",
    triggerConfig: { conditions: [] },
    ...overrides,
  };
}
