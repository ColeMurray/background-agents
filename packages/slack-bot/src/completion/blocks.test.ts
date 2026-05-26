import { describe, expect, it } from "vitest";
import { buildCompletionBlocks, buildPlanDecidedBlocks } from "./blocks";
import type { AgentResponse, SlackCallbackContext } from "../types";
import type { PlanArtifact } from "@open-inspect/shared";

const BASE_CONTEXT: SlackCallbackContext = {
  source: "slack",
  channel: "C123",
  threadTs: "1234567890.123456",
  repoFullName: "octocat/hello-world",
  model: "anthropic/claude-haiku-4-5",
};

const BASE_RESPONSE: AgentResponse = {
  textContent: "Done.",
  toolCalls: [],
  artifacts: [],
  success: true,
};

function getActionElements(
  blocks: ReturnType<typeof buildCompletionBlocks>
): Array<Record<string, unknown>> {
  const actionsBlock = blocks.find((block) => block.type === "actions");
  if (!actionsBlock || !actionsBlock.elements) {
    return [];
  }
  return actionsBlock.elements as Array<Record<string, unknown>>;
}

describe("buildCompletionBlocks", () => {
  it("renders only View Session when there are no artifacts", () => {
    const blocks = buildCompletionBlocks(
      "session-123",
      BASE_RESPONSE,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);

    expect(actionElements).toHaveLength(1);
    expect(actionElements[0]?.action_id).toBe("view_session");
  });

  it("adds Create PR button for manual PR branch artifacts", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123",
          label: "Branch: open-inspect/session-123",
          metadata: {
            mode: "manual_pr",
            createPrUrl:
              "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123",
          },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);
    const createPrButton = actionElements.find((element) => element.action_id === "create_pr");

    expect(createPrButton).toBeDefined();
    expect(createPrButton?.url).toBe(
      "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123"
    );
  });

  it("does not add Create PR button when a PR artifact exists", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123",
          label: "Branch: open-inspect/session-123",
          metadata: {
            mode: "manual_pr",
            createPrUrl:
              "https://github.com/octocat/hello-world/pull/new/main...open-inspect%2Fsession-123",
          },
        },
        {
          type: "pr",
          url: "https://github.com/octocat/hello-world/pull/99",
          label: "PR #99",
          metadata: { number: 99 },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);
    const createPrButton = actionElements.find((element) => element.action_id === "create_pr");

    expect(createPrButton).toBeUndefined();
  });

  it("does not add Create PR button for non-manual branch artifacts", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/hello-world/tree/feature-branch",
          label: "Branch: feature-branch",
          metadata: {
            mode: "auto_branch",
            createPrUrl: "https://github.com/octocat/hello-world/pull/new/main...feature-branch",
          },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);
    const createPrButton = actionElements.find((element) => element.action_id === "create_pr");

    expect(createPrButton).toBeUndefined();
  });

  it("falls back to branch artifact URL when createPrUrl is missing", () => {
    const fallbackUrl = "https://github.com/octocat/hello-world/pull/new/main...feature-branch";
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: fallbackUrl,
          label: "Branch: feature-branch",
          metadata: {
            mode: "manual_pr",
          },
        },
      ],
    };

    const blocks = buildCompletionBlocks(
      "session-123",
      response,
      BASE_CONTEXT,
      "https://app.openinspect.dev"
    );
    const actionElements = getActionElements(blocks);
    const createPrButton = actionElements.find((element) => element.action_id === "create_pr");

    expect(createPrButton).toBeDefined();
    expect(createPrButton?.url).toBe(fallbackUrl);
  });
});

// ─── buildPlanDecidedBlocks ──────────────────────────────────────────────────
// Used to update the original plan-awaiting-approval Slack message after the
// user submits the approve / reject modal — removes the buttons, swaps the
// header for a verdict, and appends a context line. Without this update the
// buttons stay clickable even though the plan is in a terminal state.

const BASE_PLAN: PlanArtifact = {
  id: "plan-1",
  version: 3,
  content: "## Plan\n- step A\n- step B",
  createdByAuthorId: null,
  createdByMessageId: null,
  source: "agent",
  createdAt: 1700000000,
};

describe("buildPlanDecidedBlocks", () => {
  it("renders the approved verdict with no action buttons", () => {
    const blocks = buildPlanDecidedBlocks({
      sessionId: "sess-1",
      plan: BASE_PLAN,
      webAppUrl: "https://app.openinspect.dev",
      verdict: "approved",
      actorMention: "<@U123>",
      implementationModelLabel: "Claude Sonnet",
    });

    // Header carries the verdict + version
    expect(blocks[0]?.text?.text).toContain(":white_check_mark:");
    expect(blocks[0]?.text?.text).toContain("Plan v3");
    expect(blocks[0]?.text?.text).toContain("approved");

    // Plan body is preserved
    expect(blocks[1]?.text?.text).toContain("step A");

    // No actions block — buttons must be gone
    expect(blocks.find((b) => b.type === "actions")).toBeUndefined();

    // Context line includes actor + impl model + web link
    const context = blocks.find((b) => b.type === "context");
    const contextText = (context?.elements?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(contextText).toContain("<@U123>");
    expect(contextText).toContain("Claude Sonnet");
    expect(contextText).toContain("https://app.openinspect.dev/session/sess-1");
  });

  it("renders the rejected verdict with reason and no buttons", () => {
    const blocks = buildPlanDecidedBlocks({
      sessionId: "sess-1",
      plan: BASE_PLAN,
      webAppUrl: "https://app.openinspect.dev",
      verdict: "rejected",
      actorMention: "<@U123>",
      reason: "Plan misses the auth flow",
    });

    expect(blocks[0]?.text?.text).toContain(":x:");
    expect(blocks[0]?.text?.text).toContain("rejected");
    expect(blocks.find((b) => b.type === "actions")).toBeUndefined();

    const context = blocks.find((b) => b.type === "context");
    const contextText = (context?.elements?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(contextText).toContain("Reason");
    expect(contextText).toContain("Plan misses the auth flow");
  });

  it("omits the reason segment when reason is null or empty", () => {
    const blocks = buildPlanDecidedBlocks({
      sessionId: "sess-1",
      plan: BASE_PLAN,
      webAppUrl: "https://app.openinspect.dev",
      verdict: "rejected",
      actorMention: "<@U123>",
      reason: null,
    });
    const context = blocks.find((b) => b.type === "context");
    const contextText = (context?.elements?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(contextText).not.toContain("Reason");
  });

  it("truncates a long reject reason so the context line stays under Slack's 2000-char limit", () => {
    // The reject modal caps input at 500 chars; this asserts the defensive
    // truncate that catches any future programmatic / API call site too.
    const longReason = "x".repeat(3000);
    const blocks = buildPlanDecidedBlocks({
      sessionId: "sess-1",
      plan: BASE_PLAN,
      webAppUrl: "https://app.openinspect.dev",
      verdict: "rejected",
      actorMention: "<@U123>",
      reason: longReason,
    });
    const context = blocks.find((b) => b.type === "context");
    const contextText = (context?.elements?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(contextText.length).toBeLessThan(2000);
    expect(contextText).toContain("…");
    expect(contextText).toMatch(/Reason: "x{500}…"/);
  });

  it("truncates long plan bodies the same way as the awaiting variant", () => {
    const longPlan: PlanArtifact = { ...BASE_PLAN, content: "x".repeat(5000) };
    const blocks = buildPlanDecidedBlocks({
      sessionId: "sess-1",
      plan: longPlan,
      webAppUrl: "https://app.openinspect.dev",
      verdict: "approved",
      actorMention: "<@U123>",
    });
    expect(blocks[1]?.text?.text).toContain("…truncated");
    // The plan body block must stay well under Slack's 3000-char section limit.
    expect((blocks[1]?.text?.text ?? "").length).toBeLessThanOrEqual(2600);
  });
});
