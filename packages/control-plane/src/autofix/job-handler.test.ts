import { describe, expect, it, vi } from "vitest";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { AutofixJobHandler } from "./job-handler";
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

const MAX_ATTEMPTS = 5;

function delivery(attempts = 1) {
  return { attempts, maxAttempts: MAX_ATTEMPTS };
}

function failingService(error: Error) {
  return {
    process: vi.fn(async () => {
      throw error;
    }),
  };
}

describe("AutofixJobHandler", () => {
  it("acknowledges a completed Autofix decision", async () => {
    const service = {
      process: vi.fn(async () => ({
        kind: "completed" as const,
        decision: "queued" as const,
        reason: "enqueued",
        messageId: "message-1",
      })),
    };
    const feedbackStore = { recordError: vi.fn(), markFailed: vi.fn() };
    const handler = new AutofixJobHandler(service, feedbackStore, () => 2_000);

    expect(await handler.handle(ENVELOPE, delivery())).toBe("ack");
    expect(feedbackStore.recordError).not.toHaveBeenCalled();
    expect(feedbackStore.markFailed).not.toHaveBeenCalled();
  });

  it("retries transient processing failures without making the ledger terminal", async () => {
    const service = failingService(new Error("GitHub rate limited"));
    const feedbackStore = {
      recordError: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => true),
    };
    const handler = new AutofixJobHandler(service, feedbackStore, () => 2_000);

    expect(await handler.handle(ENVELOPE, delivery(2))).toEqual({ retry: true });
    expect(feedbackStore.recordError).toHaveBeenCalledWith(
      "github:pr_comment:1234",
      "GitHub rate limited"
    );
    expect(feedbackStore.markFailed).not.toHaveBeenCalled();
  });

  it("records a terminal failure before the exhausted delivery moves to the DLQ", async () => {
    const service = failingService(new Error("GitHub unavailable"));
    const feedbackStore = {
      recordError: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => true),
    };
    const handler = new AutofixJobHandler(service, feedbackStore, () => 2_000);

    expect(await handler.handle(ENVELOPE, delivery(MAX_ATTEMPTS))).toEqual({ retry: true });
    expect(feedbackStore.markFailed).toHaveBeenCalledWith(
      "github:pr_comment:1234",
      "delivery_attempts_exhausted",
      "GitHub unavailable",
      2_000
    );
  });

  it("acknowledges an exhausted delivery when another worker already made it terminal", async () => {
    const service = failingService(new Error("GitHub unavailable"));
    const feedbackStore = {
      recordError: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => false),
    };
    const handler = new AutofixJobHandler(service, feedbackStore, () => 2_000);

    expect(await handler.handle(ENVELOPE, delivery(MAX_ATTEMPTS))).toBe("ack");
  });

  it("fails and acknowledges permanent provider errors without retrying", async () => {
    const service = failingService(
      new SourceControlProviderError("Comment not found", "permanent", 404)
    );
    const feedbackStore = {
      recordError: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => true),
    };
    const handler = new AutofixJobHandler(service, feedbackStore, () => 2_000);

    expect(await handler.handle(ENVELOPE, delivery(1))).toBe("ack");
    expect(feedbackStore.markFailed).toHaveBeenCalledWith(
      "github:pr_comment:1234",
      "permanent_provider_error",
      "Comment not found",
      2_000
    );
    expect(feedbackStore.recordError).not.toHaveBeenCalled();
  });
});
