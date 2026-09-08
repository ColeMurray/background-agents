/**
 * Build context blocks for Sentry automation events.
 */

import type {
  SentryIssueAlertPayload,
  SentryIssueWebhookPayload,
  SentryMetricAlertPayload,
} from "./payloads";

const MAX_STACK_FRAMES = 5;

export function buildSentryContextBlock(payload: SentryIssueAlertPayload): string {
  const { event, issue } = payload.data;
  const { metadata } = event;

  const title =
    metadata.type && metadata.value ? `${metadata.type}: ${metadata.value}` : String(issue.title);

  const lines: string[] = [
    "This automation was triggered by a new Sentry error.",
    "",
    `Error: ${title}`,
    `Project: ${issue.project.slug}`,
    `Level: ${issue.level}`,
    `Issue: ${issue.shortId}`,
    `First seen: ${issue.firstSeen}`,
    `Events (last 24h): ${issue.count}`,
    `Culprit: ${issue.culprit}`,
  ];

  // Stack trace
  const exception = event.exception;
  if (exception?.values?.length) {
    const stacktrace = exception.values.at(-1)?.stacktrace;

    if (stacktrace?.frames?.length) {
      // Frames are bottom-to-top in Sentry; reverse for most recent first
      const frames = [...stacktrace.frames].reverse().slice(0, MAX_STACK_FRAMES);
      lines.push("");
      lines.push(
        `Stack trace (top ${Math.min(frames.length, MAX_STACK_FRAMES)} frames, most recent first):`
      );
      for (const frame of frames) {
        const filename = frame.filename || frame.abs_path || "unknown";
        const fn = frame.function || "?";
        const lineno = frame.lineno ? `:${frame.lineno}` : "";
        lines.push(`  ${filename}${lineno}  ${fn}`);
      }
    }
  }

  // Tags
  const tags = event.tags;
  if (tags?.length) {
    lines.push("");
    lines.push(`Tags: ${tags.map((t) => `${t.key}=${t.value}`).join(", ")}`);
  }

  return lines.join("\n");
}

export function buildSentryIssueWebhookContextBlock(payload: SentryIssueWebhookPayload): string {
  const issue = payload.data.issue;
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

export function buildSentryMetricContextBlock(payload: SentryMetricAlertPayload): string {
  const alert = payload.data.metric_alert;
  const lines = [
    "This automation was triggered by a Sentry metric alert.",
    "",
    `Alert: ${alert.title}`,
    `Trigger: ${alert.current_trigger.label}`,
    `Started: ${alert.date_started}`,
    `URL: ${payload.data.web_url}`,
    "",
    `Description: ${payload.data.description_text}`,
  ];
  return lines.join("\n");
}
