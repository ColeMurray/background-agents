/**
 * Normalize Sentry webhook payloads into SentryAutomationEvent.
 */

import { z } from "zod";

import type { SentryAutomationEvent } from "../types";
import { buildSentryContextBlock } from "./context";

// ─── Schemas ────────────────────────────────────────────────────────────────
// Each schema is the single source of truth for one Sentry webhook shape: it
// produces the static payload type via `z.infer` and validates at runtime via
// `safeParse`. Only fields consumed by normalization and context builders are
// modeled.

const sentryIssueWebhookSchema = z.object({
  action: z.literal("created"),
  data: z.object({
    issue: z.object({
      id: z.string(),
      shortId: z.string(),
      title: z.string(),
      culprit: z.string().nullish(),
      level: z.string(),
      count: z.union([z.string(), z.number()]).optional(),
      firstSeen: z.string().nullish(),
      project: z.object({
        slug: z.string(),
      }),
      web_url: z.string().optional(),
    }),
  }),
});

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
type SentryIssueWebhookPayload = z.infer<typeof sentryIssueWebhookSchema>;

export function normalizeSentryEvent(
  payload: Record<string, unknown>,
  automationId?: string,
  sentryHookResource?: string | null
): SentryAutomationEvent | null {
  if (!sentryHookResource || sentryHookResource === "issue") {
    const issueWebhookResult = sentryIssueWebhookSchema.safeParse(payload);
    if (issueWebhookResult.success) {
      const issue = issueWebhookResult.data.data.issue;
      return {
        source: "sentry",
        automationId: automationId ?? "",
        eventType: "issue.created",
        triggerKey: `sentry_issue:${issue.id}`,
        concurrencyKey: `sentry_issue:${issue.id}`,
        sentryProject: issue.project.slug,
        sentryLevel: issue.level,
        contextBlock: buildSentryIssueWebhookContextBlock(issueWebhookResult.data),
        meta: {
          issueId: issue.id,
          shortId: issue.shortId,
          issueUrl: issue.web_url,
        },
      };
    }

    if (sentryHookResource === "issue") return null;
  }

  // Legacy issue alert (`event_alert` resource)
  const issueResult = sentryIssueAlertSchema.safeParse(payload);
  if ((!sentryHookResource || sentryHookResource === "event_alert") && issueResult.success) {
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
  if ((!sentryHookResource || sentryHookResource === "metric_alert") && metricResult.success) {
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

function buildSentryIssueWebhookContextBlock(p: SentryIssueWebhookPayload): string {
  const issue = p.data.issue;
  const lines = [
    "This automation was triggered by a new Sentry issue.",
    "",
    `Error: ${issue.title}`,
    `Project: ${issue.project.slug}`,
    `Level: ${issue.level}`,
    `Issue: ${issue.shortId}`,
  ];

  if (issue.firstSeen) lines.push(`First seen: ${issue.firstSeen}`);
  if (issue.count !== undefined) lines.push(`Events: ${issue.count}`);
  if (issue.culprit) lines.push(`Culprit: ${issue.culprit}`);
  if (issue.web_url) lines.push(`URL: ${issue.web_url}`);

  return lines.join("\n");
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
