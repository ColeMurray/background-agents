import { describe, expect, it, vi } from "vitest";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { JOBS, type JobDelivery } from "../jobs";
import { AutofixQueueConsumer } from "./queue-consumer";
import { SourceControlProviderError } from "../source-control/errors";

const ENVELOPE: GitHubAutofixEnvelope = {
  version: 1,
  eventType: "issue_comment",
  action: "created",
  deliveryId: "delivery-1",
  providerObject: { kind: "pr_comment", id: "1234" },
  repository: { id: "99", owner: "acme", name: "widgets" },
  pullRequestNumber: 42,
  receivedAt: "2026-07-30T05:00:00.000Z",
};

/** One delivery of an autofix job, at the kind's own attempt budget. */
function delivery(attempts = 1): JobDelivery {
  return { id: "job-1", attempts, maxAttempts: JOBS["github.autofix"].maxAttempts };
}

describe("AutofixQueueConsumer", () => {
  it("retries a malformed envelope without creating a ledger decision", async () => {
    const service = {
      process: vi.fn(),
    };
    const feedbackStore = {
      recordError: vi.fn(),
      markFailed: vi.fn(),
      markSkipped: vi.fn(),
    };
    const consumer = new AutofixQueueConsumer(service, feedbackStore, () => 2_000);
    expect(await consumer.run({ version: 1 }, delivery())).toBe("retry");

    expect(service.process).not.toHaveBeenCalled();
    expect(feedbackStore.recordError).not.toHaveBeenCalled();
    expect(feedbackStore.markFailed).not.toHaveBeenCalled();
    expect(feedbackStore.markSkipped).not.toHaveBeenCalled();
  });

  it("acknowledges a completed Autofix decision", async () => {
    const service = {
      process: vi.fn(async () => ({
        kind: "completed" as const,
        decision: "queued" as const,
        reason: "enqueued",
        messageId: "message-1",
      })),
    };
    const feedbackStore = {
      recordError: vi.fn(),
      markFailed: vi.fn(),
    };
    const consumer = new AutofixQueueConsumer(service, feedbackStore, () => 2_000);
    expect(await consumer.run(ENVELOPE, delivery())).toBe("ack");
  });

  it("retries transient processing failures without making the ledger terminal", async () => {
    const service = {
      process: vi.fn(async () => {
        throw new Error("GitHub rate limited");
      }),
    };
    const feedbackStore = {
      recordError: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => true),
    };
    const consumer = new AutofixQueueConsumer(service, feedbackStore, () => 2_000);
    expect(await consumer.run(ENVELOPE, delivery(2))).toBe("retry");

    expect(feedbackStore.recordError).toHaveBeenCalledWith(
      "github:pr_comment:1234",
      "GitHub rate limited"
    );
    expect(feedbackStore.markFailed).not.toHaveBeenCalled();
  });

  it("records a terminal failure before the exhausted delivery moves to the DLQ", async () => {
    const service = {
      process: vi.fn(async () => {
        throw new Error("GitHub unavailable");
      }),
    };
    const feedbackStore = {
      recordError: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => true),
    };
    const consumer = new AutofixQueueConsumer(service, feedbackStore, () => 2_000);
    expect(await consumer.run(ENVELOPE, delivery(5))).toBe("retry");

    expect(feedbackStore.markFailed).toHaveBeenCalledWith(
      "github:pr_comment:1234",
      "delivery_attempts_exhausted",
      "GitHub unavailable",
      2_000
    );
  });

  it("acknowledges an exhausted delivery when another worker already made it terminal", async () => {
    const service = {
      process: vi.fn(async () => {
        throw new Error("GitHub unavailable");
      }),
    };
    const feedbackStore = {
      recordError: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => false),
    };
    const consumer = new AutofixQueueConsumer(service, feedbackStore, () => 2_000);
    expect(await consumer.run(ENVELOPE, delivery(5))).toBe("ack");
  });

  it("fails and acknowledges permanent provider errors without retrying", async () => {
    const service = {
      process: vi.fn(async () => {
        throw new SourceControlProviderError("Comment not found", "permanent", 404);
      }),
    };
    const feedbackStore = {
      recordError: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => true),
    };
    const consumer = new AutofixQueueConsumer(service, feedbackStore, () => 2_000);
    expect(await consumer.run(ENVELOPE, delivery())).toBe("ack");

    expect(feedbackStore.markFailed).toHaveBeenCalledWith(
      "github:pr_comment:1234",
      "permanent_provider_error",
      "Comment not found",
      2_000
    );
  });
});
