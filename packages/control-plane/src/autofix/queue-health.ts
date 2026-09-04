import type { QueueMetrics, QueueMetricsSource } from "../platform-ports";

const PRIMARY_BACKLOG_ALERT_THRESHOLD = 25;
const PRIMARY_OLDEST_MESSAGE_ALERT_MS = 5 * 60 * 1_000;

interface AutofixQueueBindings {
  AUTOFIX_QUEUE?: QueueMetricsSource;
  AUTOFIX_DLQ?: QueueMetricsSource;
}

interface ErrorLogger {
  error(message: string, context?: Record<string, unknown>): void;
}

type QueueKind = "primary" | "dead_letter";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oldestMessageAgeMs(metrics: QueueMetrics, now: Date): number | null {
  if (!metrics.oldestMessageTimestamp) {
    return null;
  }

  return Math.max(0, now.getTime() - metrics.oldestMessageTimestamp.getTime());
}

async function inspectQueue(
  queue: QueueMetricsSource,
  queueKind: QueueKind,
  log: ErrorLogger,
  now: Date
): Promise<void> {
  let metrics: QueueMetrics;
  try {
    metrics = await queue.metrics();
  } catch (error) {
    log.error("Failed to inspect Autofix queue", {
      event: "autofix.queue_metrics_failed",
      queue: queueKind,
      error: errorMessage(error),
    });
    return;
  }

  const ageMs = oldestMessageAgeMs(metrics, now);
  const reason =
    queueKind === "dead_letter" && metrics.backlogCount > 0
      ? "messages_in_dead_letter_queue"
      : queueKind === "primary" && metrics.backlogCount > PRIMARY_BACKLOG_ALERT_THRESHOLD
        ? "backlog_threshold_exceeded"
        : queueKind === "primary" && ageMs !== null && ageMs > PRIMARY_OLDEST_MESSAGE_ALERT_MS
          ? "oldest_message_threshold_exceeded"
          : null;

  if (!reason) {
    return;
  }

  log.error("Autofix queue requires attention", {
    event: "autofix.queue_health",
    queue: queueKind,
    reason,
    backlog_count: metrics.backlogCount,
    backlog_bytes: metrics.backlogBytes,
    oldest_message_age_ms: ageMs,
  });
}

export async function checkAutofixQueueHealth(
  env: AutofixQueueBindings,
  log: ErrorLogger,
  now: Date = new Date()
): Promise<void> {
  const checks: Array<Promise<void>> = [];

  if (env.AUTOFIX_QUEUE) {
    checks.push(inspectQueue(env.AUTOFIX_QUEUE, "primary", log, now));
  }
  if (env.AUTOFIX_DLQ) {
    checks.push(inspectQueue(env.AUTOFIX_DLQ, "dead_letter", log, now));
  }

  await Promise.all(checks);
}
