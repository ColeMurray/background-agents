/**
 * Build context blocks for Sentry automation events.
 */

import type {
  SentryEventAlertPayload,
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

export function buildSentryEventAlertContextBlock(
  payload: SentryEventAlertPayload,
  projectSlug: string
): string {
  const { event, triggered_rule } = payload.data;
  const metadata = event.metadata;
  const title =
    metadata?.type && metadata.value ? `${metadata.type}: ${metadata.value}` : event.title;

  const lines: string[] = [
    "This automation was triggered by a Sentry issue alert rule.",
    "",
    `Error: ${title ?? "(no title)"}`,
    `Project: ${projectSlug}`,
    `Level: ${event.level ?? "unknown"}`,
    `Issue ID: ${event.issue_id}`,
    `Alert rule: ${triggered_rule}`,
  ];
  if (event.culprit) lines.push(`Culprit: ${event.culprit}`);
  if (event.web_url) lines.push(`URL: ${event.web_url}`);

  const frames = event.exception?.values?.at(-1)?.stacktrace?.frames;
  if (frames?.length) {
    const top = [...frames].reverse().slice(0, MAX_STACK_FRAMES);
    lines.push("");
    lines.push(`Stack trace (top ${top.length} frames, most recent first):`);
    for (const frame of top) {
      const filename = frame.filename || frame.abs_path || "unknown";
      const lineno = frame.lineno ? `:${frame.lineno}` : "";
      lines.push(`  ${filename}${lineno}  ${frame.function || "?"}`);
    }
  }

  if (event.tags?.length) {
    lines.push("");
    lines.push(`Tags: ${event.tags.map(([key, value]) => `${key}=${value}`).join(", ")}`);
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
