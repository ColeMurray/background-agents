/**
 * Build context blocks for Sentry automation events.
 */

const MAX_STACK_FRAMES = 5;

export function buildSentryContextBlock(payload: Record<string, unknown>): string {
  const data = payload.data as Record<string, unknown>;
  const event = data.event as Record<string, unknown>;
  const issue = data.issue as Record<string, unknown>;
  const project = issue.project as Record<string, unknown>;
  const metadata = event.metadata as Record<string, unknown>;

  const title =
    metadata.type && metadata.value ? `${metadata.type}: ${metadata.value}` : String(issue.title);

  const lines: string[] = [
    "This automation was triggered by a new Sentry error.",
    "",
    `Error: ${title}`,
    `Project: ${project.slug}`,
    `Level: ${issue.level}`,
    `Issue: ${issue.shortId}`,
    `First seen: ${issue.firstSeen}`,
    `Events (last 24h): ${issue.count}`,
    `Culprit: ${issue.culprit}`,
  ];

  // Stack trace
  const exception = event.exception as { values?: Array<Record<string, unknown>> } | undefined;
  if (exception?.values?.length) {
    const lastException = exception.values[exception.values.length - 1];
    const stacktrace = lastException.stacktrace as
      | {
          frames?: Array<Record<string, unknown>>;
        }
      | undefined;

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
  const tags = event.tags as Array<{ key: string; value: string }> | undefined;
  if (tags?.length) {
    lines.push("");
    lines.push(`Tags: ${tags.map((t) => `${t.key}=${t.value}`).join(", ")}`);
  }

  return lines.join("\n");
}
