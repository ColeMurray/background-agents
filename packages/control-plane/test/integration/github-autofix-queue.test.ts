import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import worker from "../../src/index";
import { cleanD1Tables } from "./cleanup";

// Named as Terraform names it: the kind is recovered from the queue prefix.
const QUEUE_NAME = "open-inspect-github-autofix-integration-test";

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

async function ledgerRow(feedbackKey: string) {
  return env.DB.prepare(
    "SELECT decision, reason, delivery_count FROM pr_autofix_feedback WHERE feedback_key = ?"
  )
    .bind(feedbackKey)
    .first<{ decision: string; reason: string | null; delivery_count: number }>();
}

describe("GitHub autofix Queue integration", () => {
  beforeEach(cleanD1Tables);

  it("routes the autofix queue to its handler through the Worker Queue entrypoint", async () => {
    const batch = createMessageBatch(QUEUE_NAME, [
      { id: "autofix-message-1", timestamp: new Date(), attempts: 1, body: ENVELOPE },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const queueResult = await getQueueResult(batch, ctx);

    // Feedback on a pull request no session owns is decided and retired.
    expect(queueResult.explicitAcks).toEqual(["autofix-message-1"]);
    expect(queueResult.retryMessages).toEqual([]);
    expect(await ledgerRow("github:pr_comment:1234")).toEqual({
      decision: "skipped",
      reason: "untracked_pull_request",
      delivery_count: 1,
    });
  });

  it("retries a message that is not an envelope, so it dead-letters instead of vanishing", async () => {
    const batch = createMessageBatch(QUEUE_NAME, [
      { id: "autofix-message-bad", timestamp: new Date(), attempts: 1, body: { version: 1 } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const queueResult = await getQueueResult(batch, ctx);

    expect(queueResult.explicitAcks).toEqual([]);
    expect(queueResult.retryMessages).toHaveLength(1);
    expect(queueResult.retryMessages[0]).toMatchObject({ msgId: "autofix-message-bad" });
    expect(await ledgerRow("github:pr_comment:1234")).toBeNull();
  });
});
