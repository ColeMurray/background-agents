/**
 * Normalize Sentry webhook payloads into SentryAutomationEvent.
 */

import { z } from "zod";

import type { SentryAutomationEvent } from "../types";
import { buildSentryContextBlock } from "./context";

// ─── Schemas ────────────────────────────────────────────────────────────────
// Each schema is the single source of truth for one Sentry webhook shape: it
// produces the static payload type via `z.infer` and validates at runtime via
// `safeParse`. Only the fields consumed for trigger/concurrency keys and `meta`
// are modeled. A successful parse guarantees the structural fields that
// `buildSentryContextBlock` dereferences off the raw payload (`data.event`,
// `data.event.metadata`, `data.issue`, `data.issue.project`).

const sentryIssueAlertSchema = z.object({
  action: z.string(),
  data: z.object({
    event: z.object({
      metadata: z.object({
        filename: z.string().optional(),
      }),
    }),
    issue: z.object({
      id: z.string(),
      shortId: z.string(),
      level: z.string(),
      status: z.string(),
      lastSeen: z.string(),
      project: z.object({
        slug: z.string(),
      }),
    }),
    triggered_rule: z.string(),
  }),
});

const sentryMetricAlertSchema = z.object({
  action: z.string(),
  data: z.object({
    metric_alert: z.object({
      id: z.number(),
      title: z.string(),
      date_started: z.string(),
      alert_rule: z.object({
        id: z.number(),
      }),
      current_trigger: z.object({
        label: z.string(),
      }),
    }),
    web_url: z.string(),
    description_text: z.string(),
    description_title: z.string(),
  }),
});

type SentryMetricAlertPayload = z.infer<typeof sentryMetricAlertSchema>;

export function normalizeSentryEvent(
  payload: Record<string, unknown>,
  automationId?: string
): SentryAutomationEvent | null {
  // Issue alert (event_alert action or issue action)
  const issueResult = sentryIssueAlertSchema.safeParse(payload);
  if (issueResult.success) {
    const { action, data } = issueResult.data;
    const issue = data.issue;
    const isRegression = action === "regression" || issue.status === "regressed";
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
      culpritFile: data.event.metadata.filename,
      contextBlock: buildSentryContextBlock(payload),
      meta: {
        issueId: issue.id,
        shortId: issue.shortId,
        triggeredRule: data.triggered_rule,
      },
    };
  }

  // Metric alert
  const metricResult = sentryMetricAlertSchema.safeParse(payload);
  if (metricResult.success) {
    const p = metricResult.data;
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
