/**
 * Normalize Sentry webhook payloads into SentryAutomationEvent.
 */

import type { SentryAutomationEvent } from "../types";
import { buildSentryContextBlock } from "./context";

// Sentry webhook payload shapes (minimal typed subset)

interface SentryIssueAlertPayload {
  action: string;
  data: {
    event: {
      event_id: string;
      title: string;
      culprit: string;
      level: string;
      metadata: {
        type?: string;
        value?: string;
        filename?: string;
        function?: string;
      };
      exception?: {
        values: Array<{
          type: string;
          value: string;
          stacktrace?: {
            frames: Array<{
              filename: string;
              function: string;
              lineno: number;
              colno: number;
              abs_path: string;
              in_app: boolean;
            }>;
          };
        }>;
      };
      tags: Array<{ key: string; value: string }>;
    };
    issue: {
      id: string;
      shortId: string;
      title: string;
      culprit: string;
      level: string;
      project: { id: number; slug: string; name: string };
      count: string;
      firstSeen: string;
      lastSeen: string;
      status: string;
    };
    triggered_rule: string;
  };
  actor: { type: string; id: number; name: string };
}

interface SentryMetricAlertPayload {
  action: string;
  data: {
    metric_alert: {
      id: number;
      title: string;
      alert_rule: { id: number; name: string };
      date_started: string;
      current_trigger: { label: string };
    };
    description_text: string;
    description_title: string;
    web_url: string;
  };
}

export function normalizeSentryEvent(
  payload: Record<string, unknown>,
  automationId?: string
): SentryAutomationEvent | null {
  // Issue alert (event_alert action or issue action)
  if (isIssueAlertPayload(payload)) {
    const p = payload;
    const issue = p.data.issue;
    const isRegression = p.action === "regression" || issue.status === "regressed";
    const eventType = isRegression ? "issue.regression" : "issue.created";
    const triggerKey = isRegression
      ? `sentry_regression:${issue.id}:${issue.lastSeen}`
      : `sentry_issue:${issue.id}`;
    const concurrencyKey = `sentry_issue:${issue.id}`;

    return {
      source: "sentry",
      automationId: automationId ?? "",
      eventType,
      triggerKey,
      concurrencyKey,
      sentryProject: issue.project.slug,
      sentryLevel: issue.level,
      culpritFile: p.data.event.metadata.filename,
      contextBlock: buildSentryContextBlock(payload),
      meta: {
        issueId: issue.id,
        shortId: issue.shortId,
        triggeredRule: p.data.triggered_rule,
      },
    };
  }

  // Metric alert
  if (isMetricAlertPayload(payload)) {
    const p = payload;
    if (p.action !== "critical") return null;

    const alert = p.data.metric_alert;
    const triggerKey = `sentry_metric:${alert.alert_rule.id}:${alert.date_started}`;
    const concurrencyKey = `sentry_metric:${alert.alert_rule.id}`;

    return {
      source: "sentry",
      automationId: automationId ?? "",
      eventType: "metric_alert.critical",
      triggerKey,
      concurrencyKey,
      sentryProject: "",
      sentryLevel: "critical",
      contextBlock: buildSentryMetricContextBlock(p),
      meta: {
        alertRuleId: alert.alert_rule.id,
        alertTitle: alert.title,
      },
    };
  }

  return null;
}

function isIssueAlertPayload(payload: unknown): payload is SentryIssueAlertPayload {
  if (!isRecord(payload)) return false;
  if (typeof payload.action !== "string") return false;
  if (!isRecord(payload.data)) return false;

  const { event, issue, triggered_rule: triggeredRule } = payload.data;
  if (!isRecord(event) || !isRecord(issue) || typeof triggeredRule !== "string") return false;
  if (!isRecord(event.metadata)) return false;

  const metadata = event.metadata;
  if (!isOptionalString(metadata.type)) return false;
  if (!isOptionalString(metadata.value)) return false;
  if (!isOptionalString(metadata.filename)) return false;
  if (!isOptionalString(metadata.function)) return false;

  if (typeof issue.id !== "string") return false;
  if (typeof issue.shortId !== "string") return false;
  if (typeof issue.title !== "string") return false;
  if (typeof issue.culprit !== "string") return false;
  if (typeof issue.level !== "string") return false;
  if (typeof issue.count !== "string") return false;
  if (typeof issue.firstSeen !== "string") return false;
  if (typeof issue.lastSeen !== "string") return false;
  if (typeof issue.status !== "string") return false;
  if (!isRecord(issue.project) || typeof issue.project.slug !== "string") return false;

  return true;
}

function isMetricAlertPayload(payload: unknown): payload is SentryMetricAlertPayload {
  if (!isRecord(payload)) return false;
  if (typeof payload.action !== "string") return false;
  if (!isRecord(payload.data)) return false;

  const data = payload.data;
  if (!isRecord(data.metric_alert)) return false;
  if (typeof data.description_text !== "string") return false;
  if (typeof data.description_title !== "string") return false;
  if (typeof data.web_url !== "string") return false;

  const alert = data.metric_alert;
  if (typeof alert.id !== "number" || !Number.isFinite(alert.id)) return false;
  if (typeof alert.title !== "string") return false;
  if (typeof alert.date_started !== "string") return false;
  if (!isRecord(alert.alert_rule)) return false;
  if (typeof alert.alert_rule.id !== "number" || !Number.isFinite(alert.alert_rule.id)) {
    return false;
  }
  if (typeof alert.alert_rule.name !== "string") return false;
  if (!isRecord(alert.current_trigger)) return false;
  if (typeof alert.current_trigger.label !== "string") return false;

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function buildSentryMetricContextBlock(p: SentryMetricAlertPayload): string {
  const alert = p.data.metric_alert;
  const lines = [
    "This automation was triggered by a Sentry metric alert.",
    "",
    `Alert: ${alert.title}`,
    `Trigger: ${alert.current_trigger.label}`,
    `Started: ${alert.date_started}`,
    `URL: ${p.data.web_url}`,
    "",
    `Description: ${p.data.description_text}`,
  ];
  return lines.join("\n");
}
