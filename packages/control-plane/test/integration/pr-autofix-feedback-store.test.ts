import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import {
  PrAutofixFeedbackStore,
  githubAutofixFeedbackKey,
} from "../../src/db/pr-autofix-feedback-store";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";

const COMMENT_ENVELOPE: GitHubAutofixEnvelope = {
  version: 1,
  eventType: "issue_comment",
  action: "created",
  deliveryId: "delivery-1",
  providerObject: { kind: "pr_comment", id: "1234" },
  repository: { id: "99", owner: "acme", name: "widgets" },
  pullRequestNumber: 42,
  receivedAt: "2026-07-30T05:00:00.000Z",
};

describe("PrAutofixFeedbackStore", () => {
  beforeEach(cleanD1Tables);

  it("records redeliveries against one natural feedback key", async () => {
    const store = new PrAutofixFeedbackStore(env.DB);

    const first = await store.receive(COMMENT_ENVELOPE, 1_000);
    const second = await store.receive({ ...COMMENT_ENVELOPE, deliveryId: "delivery-2" }, 2_000);

    expect(first.feedbackKey).toBe(githubAutofixFeedbackKey(COMMENT_ENVELOPE));
    expect(second).toMatchObject({
      feedbackKey: "github:pr_comment:1234",
      deliveryId: "delivery-2",
      decision: "received",
      deliveryCount: 2,
      firstReceivedAt: 1_000,
      lastReceivedAt: 2_000,
    });
  });

  it("records dispatch context and the terminal queued decision", async () => {
    const store = new PrAutofixFeedbackStore(env.DB);
    const receipt = await store.receive(COMMENT_ENVELOPE, 1_000);
    await new SessionIndexStore(env.DB).create({
      id: "session-1",
      title: null,
      repoOwner: "acme",
      repoName: "widgets",
      model: "test-model",
      reasoningEffort: null,
      baseBranch: "main",
      status: "active",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await store.attachContext(receipt.feedbackKey, {
      artifactId: "artifact-1",
      sessionId: "session-1",
      authorId: "7",
      authorLogin: "alice",
      authorType: "User",
      feedbackUrl: "https://github.com/acme/widgets/pull/42#issuecomment-1234",
    });
    await store.markDispatchAttempted(receipt.feedbackKey, 1_500);
    await store.markQueued(receipt.feedbackKey, "message-1", "enqueued", 2_000);

    expect(await store.get(receipt.feedbackKey)).toMatchObject({
      artifactId: "artifact-1",
      sessionId: "session-1",
      authorId: "7",
      authorLogin: "alice",
      authorType: "User",
      decision: "queued",
      reason: "enqueued",
      messageId: "message-1",
      dispatchAttemptedAt: 1_500,
      decidedAt: 2_000,
    });
  });

  it("does not let delayed skip or failure overwrite queued admission", async () => {
    const store = new PrAutofixFeedbackStore(env.DB);
    const receipt = await store.receive(COMMENT_ENVELOPE, 1_000);

    await store.markQueued(receipt.feedbackKey, "message-1", "enqueued", 2_000);

    await expect(store.markSkipped(receipt.feedbackKey, "disabled", 3_000)).resolves.toBe(false);
    await expect(
      store.markFailed(receipt.feedbackKey, "provider_error", "late failure", 4_000)
    ).resolves.toBe(false);
    expect(await store.get(receipt.feedbackKey)).toMatchObject({
      decision: "queued",
      reason: "enqueued",
      messageId: "message-1",
      decidedAt: 2_000,
    });
  });

  it("lists activity using a stable newest-first cursor", async () => {
    const store = new PrAutofixFeedbackStore(env.DB);
    await store.receive(COMMENT_ENVELOPE, 1_000);
    await store.receive(
      {
        ...COMMENT_ENVELOPE,
        deliveryId: "delivery-review",
        eventType: "pull_request_review",
        action: "submitted",
        providerObject: { kind: "review", id: "5678" },
      },
      2_000
    );

    const first = await store.listActivity({ limit: 1, cursor: null });
    expect(first.records.map((record) => record.feedbackKey)).toEqual(["github:review:5678"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.listActivity({ limit: 1, cursor: first.nextCursor });
    expect(second.records.map((record) => record.feedbackKey)).toEqual(["github:pr_comment:1234"]);
    expect(second.nextCursor).toBeNull();
  });
});
