import { describe, expect, it, vi } from "vitest";
import { checkAutofixQueueHealth } from "./queue-health";

function queue(metrics: {
  backlogCount: number;
  backlogBytes?: number;
  oldestMessageTimestamp?: Date;
}) {
  return {
    metrics: vi.fn(async () => ({
      backlogBytes: 0,
      ...metrics,
    })),
  };
}

function logger() {
  return {
    error: vi.fn(),
  };
}

describe("checkAutofixQueueHealth", () => {
  it("does nothing when Autofix queues are not configured", async () => {
    const log = logger();

    await checkAutofixQueueHealth({}, log, new Date("2026-07-29T12:00:00Z"));

    expect(log.error).not.toHaveBeenCalled();
  });

  it("alerts when any message reaches the dead-letter queue", async () => {
    const log = logger();

    await checkAutofixQueueHealth(
      {
        AUTOFIX_QUEUE: queue({ backlogCount: 0 }),
        AUTOFIX_DLQ: queue({ backlogCount: 1, backlogBytes: 128 }),
      },
      log,
      new Date("2026-07-29T12:00:00Z")
    );

    expect(log.error).toHaveBeenCalledWith("Autofix queue requires attention", {
      event: "autofix.queue_health",
      queue: "dead_letter",
      reason: "messages_in_dead_letter_queue",
      backlog_count: 1,
      backlog_bytes: 128,
      oldest_message_age_ms: null,
    });
  });

  it("alerts when the primary backlog is large", async () => {
    const log = logger();

    await checkAutofixQueueHealth(
      {
        AUTOFIX_QUEUE: queue({ backlogCount: 26 }),
        AUTOFIX_DLQ: queue({ backlogCount: 0 }),
      },
      log,
      new Date("2026-07-29T12:00:00Z")
    );

    expect(log.error).toHaveBeenCalledWith(
      "Autofix queue requires attention",
      expect.objectContaining({
        event: "autofix.queue_health",
        queue: "primary",
        reason: "backlog_threshold_exceeded",
        backlog_count: 26,
      })
    );
  });

  it("alerts when the oldest primary message exceeds five minutes", async () => {
    const log = logger();

    await checkAutofixQueueHealth(
      {
        AUTOFIX_QUEUE: queue({
          backlogCount: 1,
          oldestMessageTimestamp: new Date("2026-07-29T11:54:59Z"),
        }),
        AUTOFIX_DLQ: queue({ backlogCount: 0 }),
      },
      log,
      new Date("2026-07-29T12:00:00Z")
    );

    expect(log.error).toHaveBeenCalledWith(
      "Autofix queue requires attention",
      expect.objectContaining({
        event: "autofix.queue_health",
        queue: "primary",
        reason: "oldest_message_threshold_exceeded",
        oldest_message_age_ms: 301_000,
      })
    );
  });

  it("reports metrics failures without failing the scheduled handler", async () => {
    const log = logger();
    const failingQueue = {
      metrics: vi.fn(async () => {
        throw new Error("metrics unavailable");
      }),
    };

    await expect(
      checkAutofixQueueHealth(
        {
          AUTOFIX_QUEUE: failingQueue,
          AUTOFIX_DLQ: queue({ backlogCount: 0 }),
        },
        log,
        new Date("2026-07-29T12:00:00Z")
      )
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith("Failed to inspect Autofix queue", {
      event: "autofix.queue_metrics_failed",
      queue: "primary",
      error: "metrics unavailable",
    });
  });
});
