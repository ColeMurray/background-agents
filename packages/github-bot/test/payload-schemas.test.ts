import { describe, expect, it } from "vitest";

import {
  issueCommentPayloadSchema,
  pullRequestOpenedPayloadSchema,
  reviewCommentPayloadSchema,
  reviewRequestedPayloadSchema,
} from "../src/payload-schemas";

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

describe("GitHub bot payload schemas", () => {
  it("parses a valid pull request opened payload", () => {
    const result = pullRequestOpenedPayloadSchema.safeParse({
      action: "opened",
      pull_request: { ...pullRequest, draft: false },
      repository,
      sender,
    });

    expect(result.success).toBe(true);
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
});
