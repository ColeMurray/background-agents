import { describe, expect, it } from "vitest";

import {
  githubBotIssueCommentPayloadSchema,
  githubBotPullRequestOpenedPayloadSchema,
  githubBotReviewRequestedPrecheckPayloadSchema,
  githubBotReviewRequestedPayloadSchema,
} from "./webhook-types";

const sender = { login: "octocat", id: 123, avatar_url: "https://example.com/avatar.png" };
const repository = { owner: { login: "open-inspect" }, name: "background-agents", private: false };
const pullRequest = {
  number: 42,
  title: "Add validation",
  body: "Implements validation",
  user: { login: "contributor" },
  head: { ref: "feature/validation", sha: "abc123" },
  base: { ref: "main" },
};

describe("GitHub bot webhook payload schemas", () => {
  it("parses a valid pull request opened payload", () => {
    const result = githubBotPullRequestOpenedPayloadSchema.safeParse({
      action: "opened",
      pull_request: { ...pullRequest, draft: false },
      repository,
      sender,
    });

    expect(result.success).toBe(true);
  });

  it("rejects a malformed partial issue comment payload", () => {
    const result = githubBotIssueCommentPayloadSchema.safeParse({
      action: "created",
      issue: { number: 42, title: "Missing comment" },
      repository,
      sender,
    });

    expect(result.success).toBe(false);
  });

  it("parses nullable pull request bodies and nullable requested reviewers", () => {
    const result = githubBotReviewRequestedPayloadSchema.safeParse({
      action: "review_requested",
      pull_request: { ...pullRequest, body: null },
      requested_reviewer: null,
      repository,
      sender,
    });

    expect(result.success).toBe(true);
  });

  it("prechecks review requests without fields only needed when handling", () => {
    const result = githubBotReviewRequestedPrecheckPayloadSchema.safeParse({
      action: "review_requested",
      repository: { owner: { login: "open-inspect" }, name: "background-agents" },
    });

    expect(result.success).toBe(true);
  });
});
