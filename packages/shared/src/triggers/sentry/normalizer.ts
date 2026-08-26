/**
 * Normalize Sentry webhook payloads into SentryAutomationEvent.
 */

import type { SentryAutomationEvent } from "../types";
import {
  buildSentryContextBlock,
  buildSentryIssueWebhookContextBlock,
  buildSentryMetricContextBlock,
} from "./context";
import {
  sentryIssueAlertSchema,
  sentryIssueWebhookSchema,
  sentryMetricAlertSchema,
} from "./payloads";

export type SentryNormalizationResult =
  | { status: "normalized"; event: SentryAutomationEvent }
  | {
      status: "skipped";
      reason: "unsupported_action" | "unknown_resource" | "invalid_shape";
    };

export function normalizeSentryEvent(
  payload: Record<string, unknown>,
  automationId?: string,
  sentryHookResource?: string | null
): SentryNormalizationResult {
  if (
    sentryHookResource &&
    !["issue", "event_alert", "metric_alert"].includes(sentryHookResource)
  ) {
    return { status: "skipped", reason: "unknown_resource" };
  }

  let unsupportedIssueAction = false;
  if (!sentryHookResource || sentryHookResource === "issue") {
    const issueWebhookResult = sentryIssueWebhookSchema.safeParse(payload);
    if (issueWebhookResult.success) {
      if (issueWebhookResult.data.action !== "created") {
        if (sentryHookResource === "issue") {
          return { status: "skipped", reason: "unsupported_action" };
        }
        unsupportedIssueAction = true;
      } else {
        const issue = issueWebhookResult.data.data.issue;
        return {
          status: "normalized",
          event: {
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
          },
        };
      }
    }

    if (sentryHookResource === "issue") {
      return { status: "skipped", reason: "invalid_shape" };
    }
  }

  // Legacy issue alert (`event_alert` resource)
  if (!sentryHookResource || sentryHookResource === "event_alert") {
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
        status: "normalized",
        event: {
          source: "sentry",
          automationId: automationId ?? "",
          eventType,
          triggerKey,
          concurrencyKey,
          sentryProject: issue.project.slug,
          sentryLevel: issue.level,
          culpritFile: data.event.metadata.filename,
          contextBlock: buildSentryContextBlock(issueResult.data),
          meta: {
            issueId: issue.id,
            shortId: issue.shortId,
            triggeredRule: data.triggered_rule,
          },
        },
      };
    }

    if (sentryHookResource === "event_alert") {
      return { status: "skipped", reason: "invalid_shape" };
    }
  }

  // Metric alert
  if (!sentryHookResource || sentryHookResource === "metric_alert") {
    const metricResult = sentryMetricAlertSchema.safeParse(payload);
    if (metricResult.success) {
      const p = metricResult.data;
      if (p.action !== "critical") {
        return { status: "skipped", reason: "unsupported_action" };
      }

      const alert = p.data.metric_alert;
      const triggerKey = `sentry_metric:${alert.alert_rule.id}:${alert.date_started}`;
      const concurrencyKey = `sentry_metric:${alert.alert_rule.id}`;

      return {
        status: "normalized",
        event: {
          source: "sentry",
          automationId: automationId ?? "",
          eventType: "metric_alert.critical",
          triggerKey,
          concurrencyKey,
          sentryLevel: "critical",
          contextBlock: buildSentryMetricContextBlock(p),
          meta: {
            alertRuleId: alert.alert_rule.id,
            alertTitle: alert.title,
          },
        },
      };
    }

    if (sentryHookResource === "metric_alert") {
      return { status: "skipped", reason: "invalid_shape" };
    }
  }

  return {
    status: "skipped",
    reason: unsupportedIssueAction ? "unsupported_action" : "invalid_shape",
  };
}
