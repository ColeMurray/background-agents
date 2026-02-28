import { describe, expect, it } from "vitest";
import { buildCompletionText } from "./cards";
import type { AgentResponse } from "../types";

const BASE_RESPONSE: AgentResponse = {
  textContent: "Done.",
  toolCalls: [],
  artifacts: [],
  success: true,
};

describe("buildCompletionText", () => {
  it("renders basic completion with session link", () => {
    const text = buildCompletionText(
      "session-123",
      BASE_RESPONSE,
      "octocat/hello-world",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).toContain("Done.");
    expect(text).toContain("\u2705 Done");
    expect(text).toContain("claude-sonnet-4-6");
    expect(text).toContain("octocat/hello-world");
    expect(text).toContain("[View Session](https://app.example.com/session/session-123)");
  });

  it("includes reasoning effort suffix", () => {
    const text = buildCompletionText(
      "session-123",
      BASE_RESPONSE,
      "octocat/repo",
      "claude-sonnet-4-6",
      "high",
      "https://app.example.com"
    );

    expect(text).toContain("(high)");
  });

  it("shows warning icon for failed sessions", () => {
    const response: AgentResponse = { ...BASE_RESPONSE, success: false };
    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).toContain("\u26a0\ufe0f Completed with issues");
  });

  it("shows placeholder text when agent has no text content", () => {
    const response: AgentResponse = { ...BASE_RESPONSE, textContent: "" };
    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).toContain("_Agent completed._");
  });

  it("renders artifact links", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        { type: "pr", url: "https://github.com/octocat/repo/pull/42", label: "PR #42" },
        {
          type: "branch",
          url: "https://github.com/octocat/repo/tree/feature",
          label: "Branch: feature",
        },
      ],
    };

    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).toContain("**Created:**");
    expect(text).toContain("- [PR #42](https://github.com/octocat/repo/pull/42)");
    expect(text).toContain("- [Branch: feature](https://github.com/octocat/repo/tree/feature)");
  });

  it("renders artifact without URL as plain text", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [{ type: "branch", url: "", label: "Branch: feature" }],
    };

    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).toContain("- Branch: feature");
    expect(text).not.toContain("[Branch: feature]()");
  });

  it("adds Create PR link for manual_pr branch when no PR artifact exists", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/repo/tree/feature",
          label: "Branch: feature",
          metadata: {
            mode: "manual_pr",
            createPrUrl: "https://github.com/octocat/repo/pull/new/main...feature",
          },
        },
      ],
    };

    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).toContain("[Create PR](https://github.com/octocat/repo/pull/new/main...feature)");
  });

  it("does not add Create PR link when a PR artifact exists", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/repo/tree/feature",
          label: "Branch: feature",
          metadata: { mode: "manual_pr", createPrUrl: "https://example.com/pr" },
        },
        { type: "pr", url: "https://github.com/octocat/repo/pull/99", label: "PR #99" },
      ],
    };

    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).not.toContain("[Create PR]");
  });

  it("does not add Create PR link for non-manual branch artifacts", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/repo/tree/feature",
          label: "Branch: feature",
          metadata: { mode: "auto_branch", createPrUrl: "https://example.com/pr" },
        },
      ],
    };

    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).not.toContain("[Create PR]");
  });

  it("falls back to artifact URL when createPrUrl is missing in manual_pr mode", () => {
    const fallbackUrl = "https://github.com/octocat/repo/pull/new/main...feature";
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: fallbackUrl,
          label: "Branch: feature",
          metadata: { mode: "manual_pr" },
        },
      ],
    };

    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).toContain(`[Create PR](${fallbackUrl})`);
  });

  it("truncates long text with smart break", () => {
    // Create text > 2000 chars with a sentence break in the last 30%
    const longText = "A".repeat(1500) + ". " + "B".repeat(600);
    const response: AgentResponse = { ...BASE_RESPONSE, textContent: longText };

    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).toContain("_...truncated_");
    // Should break at the period since it's after 70% mark
    expect(text).toContain("A.\n\n_...truncated_");
  });

  it("truncates with ellipsis when no smart break point exists", () => {
    const longText = "A".repeat(2500);
    const response: AgentResponse = { ...BASE_RESPONSE, textContent: longText };

    const text = buildCompletionText(
      "session-123",
      response,
      "octocat/repo",
      "claude-sonnet-4-6",
      undefined,
      "https://app.example.com"
    );

    expect(text).toContain("...\n\n_...truncated_");
  });
});
