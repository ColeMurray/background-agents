/**
 * Core types for the trigger-based automation event system.
 */

import type { AutomationTriggerType } from "../types";
import type { ConditionType } from "./conditions";

// ─── Event Sources ────────────────────────────────────────────────────────────

export type AutomationEventSource = "github" | "linear" | "sentry" | "webhook";

// ─── Base Event ───────────────────────────────────────────────────────────────

interface BaseAutomationEvent {
  /** Dot-delimited event type (e.g., "pull_request.opened", "issue.created"). */
  eventType: string;

  /** Trigger key for dedup and concurrency (e.g., "pr:42", "sentry_issue:12345"). */
  triggerKey: string;

  /** Concurrency key — the stable prefix of triggerKey for concurrency scoping. */
  concurrencyKey: string;

  /** Human-readable context block prepended to automation instructions. */
  contextBlock: string;

  /** Raw event metadata for logging/debugging. Not used for matching. */
  meta: Record<string, unknown>;
}

// ─── Source-Specific Variants ─────────────────────────────────────────────────

export interface GitHubAutomationEvent extends BaseAutomationEvent {
  source: "github";
  repoOwner: string;
  repoName: string;
  branch?: string;
  labels?: string[];
  actor?: string;
  changedFiles?: string[];
  checkConclusion?: string;
}

export interface LinearAutomationEvent extends BaseAutomationEvent {
  source: "linear";
  repoOwner: string;
  repoName: string;
  actor?: string;
  labels?: string[];
  linearStatus?: string;
}

export interface SentryAutomationEvent extends BaseAutomationEvent {
  source: "sentry";
  sentryProject: string;
  sentryLevel: string;
  culpritFile?: string;
}

export interface WebhookAutomationEvent extends BaseAutomationEvent {
  source: "webhook";
  automationId: string;
  body: unknown;
}

// ─── Discriminated Union ──────────────────────────────────────────────────────

export type AutomationEvent =
  | GitHubAutomationEvent
  | LinearAutomationEvent
  | SentryAutomationEvent
  | WebhookAutomationEvent;

// ─── Trigger Source Definition ────────────────────────────────────────────────

export interface TriggerSourceDefinition {
  /** Source identifier — must match a member of AutomationEventSource. */
  source: AutomationEventSource;

  /** The trigger_type value stored in D1. */
  triggerType: AutomationTriggerType;

  /** Human-readable name for the UI. */
  displayName: string;

  /** Short description shown in the trigger type selector. */
  description: string;

  /** Supported event types with UI metadata. */
  eventTypes: Array<{
    eventType: string;
    displayName: string;
    description: string;
  }>;

  /** Condition types this source supports (keys into ConditionConfigMap). */
  supportedConditions: ConditionType[];
}
