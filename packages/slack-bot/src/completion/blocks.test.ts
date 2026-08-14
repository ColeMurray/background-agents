import { describe, expect, it } from "vitest";
import { buildCompletionBlocks } from "./blocks";
import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import type { SlackCallbackContext } from "@open-inspect/shared/types/session-api";

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
  mediaArtifacts: [],
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
  it("escapes the target label in the mrkdwn status footer", () => {
    // Environment-launched sessions carry the raw environment name here.
    const blocks = buildCompletionBlocks(
      "session-123",
      BASE_RESPONSE,
      { ...BASE_CONTEXT, repoFullName: "<!channel> & co" },
      "https://app.openinspect.dev"
    );

    const footer = blocks.find((block) => block.type === "context");
    const footerText = (footer?.elements as Array<{ text: string }>)[0]?.text ?? "";
    expect(footerText).toContain("&lt;!channel&gt; &amp; co");
    expect(footerText).not.toContain("<!channel>");
  });

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

describe("long response handling", () => {
  // Regression: responses were capped at 2000 chars in a single section, so
  // multi-part answers (headings + citations) stopped mid-sentence even though
  // Slack accepts 3000 per section and 50 blocks per message.
  const sectionTexts = (blocks: ReturnType<typeof buildCompletionBlocks>): string[] =>
    blocks
      .filter((block) => block.type === "section")
      .map((block) => block.text?.text ?? "")
      // Drop the artifacts section, which is built separately.
      .filter((text) => !text.startsWith("*Created:*"));

  it("keeps a long multi-paragraph answer whole across several sections", () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, i) => `## Section ${i}\n\n${"detail ".repeat(120)}`
    );
    const textContent = paragraphs.join("\n\n");
    const blocks = buildCompletionBlocks(
      "sess-1",
      { ...BASE_RESPONSE, textContent },
      BASE_CONTEXT,
      "https://inspect.example.com"
    );
    const texts = sectionTexts(blocks);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.join("\n\n")).toContain("Section 7");
    expect(texts.join(" ")).not.toContain("truncated");
  });

  it("requests expanded rendering for every completion response section", () => {
    const responseSections = buildCompletionBlocks(
      "sess-1",
      { ...BASE_RESPONSE, textContent: "x".repeat(4000) },
      BASE_CONTEXT,
      "https://inspect.example.com"
    ).filter((block) => block.type === "section");

    expect(responseSections.length).toBeGreaterThan(1);
    for (const block of responseSections) {
      expect(block).toHaveProperty("expand", true);
    }
  });

  it("never exceeds Slack's per-section character limit", () => {
    const textContent = "x".repeat(25_000);
    const blocks = buildCompletionBlocks(
      "sess-2",
      { ...BASE_RESPONSE, textContent },
      BASE_CONTEXT,
      "https://inspect.example.com"
    );
    for (const text of sectionTexts(blocks)) {
      expect(text.length).toBeLessThanOrEqual(3000);
    }
  });

  it("truncates with a pointer to the session once the block budget is spent", () => {
    const textContent = Array.from({ length: 200 }, () => "q".repeat(2900)).join("\n\n");
    const blocks = buildCompletionBlocks(
      "sess-3",
      { ...BASE_RESPONSE, textContent },
      BASE_CONTEXT,
      "https://inspect.example.com"
    );
    const texts = sectionTexts(blocks);
    expect(texts.length).toBeLessThanOrEqual(20);
    expect(texts[texts.length - 1]).toContain("truncated");
    // The View Session button is the escape hatch for the remainder.
    expect(getActionElements(blocks).some((el) => el.action_id === "view_session")).toBe(true);
  });

  it("balances code fences when a fenced block spans a split", () => {
    const code = ["```ts", ...Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`), "```"];
    const blocks = buildCompletionBlocks(
      "sess-4",
      { ...BASE_RESPONSE, textContent: code.join("\n") },
      BASE_CONTEXT,
      "https://inspect.example.com"
    );
    const texts = sectionTexts(blocks);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect((text.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("respects the section cap when a fence is split (repair chars are budgeted)", () => {
    const textContent = `\`\`\`json\n${"a".repeat(9000)}\n\`\`\``;
    const blocks = buildCompletionBlocks(
      "sess-6",
      { ...BASE_RESPONSE, textContent },
      BASE_CONTEXT,
      "https://inspect.example.com"
    );
    for (const text of sectionTexts(blocks)) {
      expect(text.length).toBeLessThanOrEqual(3000);
    }
  });

  // The section cap only keeps the message postable in combination with however
  // many non-section blocks this builder emits, and that coupling lives in a
  // comment. Assert the real limit with every optional block populated, so raising
  // the cap or adding a block fails here rather than at the Slack API.
  it("stays within Slack's 50-block message limit with every block populated", () => {
    const blocks = buildCompletionBlocks(
      "sess-7",
      {
        ...BASE_RESPONSE,
        textContent: Array.from({ length: 500 }, () => "z".repeat(2900)).join("\n\n"),
        artifacts: [{ type: "branch", label: "feature/x", url: "https://example.com/tree/x" }],
        toolCalls: [
          { tool: "Edit", summary: "Edit src/a.ts" },
          { tool: "Write", summary: "Write src/b.ts" },
          { tool: "Bash", summary: "Bash npm test" },
        ],
        success: false,
        error: "something went wrong",
      } as AgentResponse,
      BASE_CONTEXT,
      "https://inspect.example.com"
    );
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it("still renders a placeholder for an empty response", () => {
    const blocks = buildCompletionBlocks(
      "sess-5",
      { ...BASE_RESPONSE, textContent: "   " },
      BASE_CONTEXT,
      "https://inspect.example.com"
    );
    expect(sectionTexts(blocks)[0]).toBe("_Agent completed._");
  });
});
