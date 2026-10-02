import { describe, expect, it } from "vitest";

import {
  issueCommentPayloadSchema,
  pullRequestReviewTriggerPayloadSchema,
  requestedReviewerPayloadSchema,
  reviewCommentPayloadSchema,
  reviewRequestedPayloadSchema,
  webhookActionPayloadSchema,
  webhookSummaryPayloadSchema,
} from "../src/payload-schemas";

const sender = { login: "octocat", id: 123, avatar_url: "https://example.com/avatar.png" };
const repository = {
  id: 555,
  owner: { login: "open-inspect" },
  name: "background-agents",
  private: false,
};
const pullRequest = {
  number: 42,
  title: "Add validation",
  body: "Implements validation",
  user: { login: "contributor" },
  head: { ref: "feature/validation", sha: "abc123" },
  base: { ref: "main" },
};

describe("GitHub bot payload schemas", () => {
  it.each(["opened", "reopened", "synchronize", "ready_for_review"] as const)(
    "parses the %s pull request review trigger",
    (action) => {
      const result = pullRequestReviewTriggerPayloadSchema.safeParse({
        action,
        pull_request: { ...pullRequest, draft: false },
        repository,
        sender,
      });

      expect(result.success).toBe(true);
    }
  );

  it.each(["closed", "converted_to_draft"] as const)(
    "rejects the %s pull request action (lifecycle events are not review triggers)",
    (action) => {
      const result = pullRequestReviewTriggerPayloadSchema.safeParse({
        action,
        pull_request: { ...pullRequest, draft: false },
        repository,
        sender,
      });

      expect(result.success).toBe(false);
    }
  );

  it("rejects a pull request action that does not trigger a review", () => {
    const result = pullRequestReviewTriggerPayloadSchema.safeParse({
      action: "labeled",
      pull_request: { ...pullRequest, draft: false },
      repository,
      sender,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a repository payload missing the numeric id", () => {
    const result = pullRequestReviewTriggerPayloadSchema.safeParse({
      action: "opened",
      pull_request: { ...pullRequest, draft: false },
      repository: { owner: { login: "open-inspect" }, name: "background-agents", private: false },
      sender,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a malformed partial issue comment payload", () => {
    const result = issueCommentPayloadSchema.safeParse({
      action: "created",
      issue: { number: 42, title: "Missing comment" },
      repository,
      sender,
    });

    expect(result.success).toBe(false);
  });

  it("parses nullable pull request bodies and nullable requested reviewers", () => {
    const result = reviewRequestedPayloadSchema.safeParse({
      action: "review_requested",
      pull_request: { ...pullRequest, body: null },
      requested_reviewer: null,
      repository,
      sender,
    });

    expect(result.success).toBe(true);
  });

  it("parses a valid pull request review comment payload", () => {
    const result = reviewCommentPayloadSchema.safeParse({
      action: "created",
      pull_request: {
        number: pullRequest.number,
        title: pullRequest.title,
        head: pullRequest.head,
        base: pullRequest.base,
      },
      comment: {
        id: 99,
        body: "@open-inspect-bot please check this",
        path: "src/index.ts",
        diff_hunk: "@@ -1,2 +1,2 @@",
        user: { login: "reviewer" },
      },
      repository,
      sender,
    });

    expect(result.success).toBe(true);
  });

  it("parses consumed webhook summary fields", () => {
    const result = webhookSummaryPayloadSchema.safeParse({
      action: "review_requested",
      repository: { owner: { login: "open-inspect" }, name: "background-agents" },
      sender: { login: "octocat" },
      pull_request: { number: 42 },
      extra: "ignored",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.repository?.owner.login).toBe("open-inspect");
  });

  it("rejects malformed webhook summary object fields", () => {
    const result = webhookSummaryPayloadSchema.safeParse({
      action: "opened",
      repository: { owner: {}, name: "background-agents" },
    });

    expect(result.success).toBe(false);
  });

  it("parses nullable webhook summary repository and requested reviewer", () => {
    const summary = webhookSummaryPayloadSchema.safeParse({
      action: "opened",
      repository: null,
      sender: null,
      pull_request: null,
      issue: null,
    });
    const reviewer = requestedReviewerPayloadSchema.safeParse({ requested_reviewer: null });

    expect(summary.success).toBe(true);
    expect(reviewer.success).toBe(true);
  });

  it("rejects malformed requested reviewer payloads", () => {
    const result = requestedReviewerPayloadSchema.safeParse({
      requested_reviewer: { id: 123 },
    });

    expect(result.success).toBe(false);
  });

  it("parses action without requiring the rest of the webhook summary", () => {
    const result = webhookActionPayloadSchema.safeParse({
      action: "opened",
      repository: { owner: {}, name: "background-agents" },
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.action).toBe("opened");
  });
});
