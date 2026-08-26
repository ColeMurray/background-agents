import { describe, expect, it } from "vitest";
import { createPullRequestToolEnvelopeSchema } from "./pull-request-tool";

describe("createPullRequestToolEnvelopeSchema", () => {
  it("accepts created and updated pull request results", () => {
    for (const kind of ["created", "updated"] as const) {
      expect(
        createPullRequestToolEnvelopeSchema.safeParse({
          kind,
          prNumber: 42,
          prUrl: "https://github.com/acme/web/pull/42",
          state: "open",
          headBranch: "feature/timeline",
          baseBranch: "main",
          agentMessage: "Pull request ready.",
        }).success
      ).toBe(true);
    }
  });

  it("accepts manual and failure results", () => {
    expect(
      createPullRequestToolEnvelopeSchema.safeParse({
        kind: "manual",
        createPrUrl: "https://github.com/acme/web/compare/main...feature",
        agentMessage: "Create the pull request in GitHub.",
      }).success
    ).toBe(true);
    expect(
      createPullRequestToolEnvelopeSchema.safeParse({
        kind: "failure",
        message: "Authentication failed.",
        agentMessage: "Authentication failed.",
      }).success
    ).toBe(true);
  });

  it("rejects incomplete results", () => {
    expect(
      createPullRequestToolEnvelopeSchema.safeParse({
        kind: "created",
        prNumber: 42,
        prUrl: "https://github.com/acme/web/pull/42",
      }).success
    ).toBe(false);
  });

  it("defaults state and accepts omitted branch metadata", () => {
    const result = createPullRequestToolEnvelopeSchema.safeParse({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      agentMessage: "Pull request ready.",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ kind: "created", state: "open" });
    }
  });
});
