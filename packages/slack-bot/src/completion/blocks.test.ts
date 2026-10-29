import { describe, expect, it } from "vitest";
import { MARKDOWN_BLOCK_MAX_CHARS } from "@open-inspect/shared/slack";
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

  it("does not add Create PR button for wrong-type manual PR metadata", () => {
    const response: AgentResponse = {
      ...BASE_RESPONSE,
      artifacts: [
        {
          type: "branch",
          url: "https://github.com/octocat/hello-world/tree/feature-branch",
          label: "Branch: feature-branch",
          metadata: {
            mode: null,
            createPrUrl: 42,
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

describe("response block", () => {
  // Regression: agent replies are standard Markdown, but they were posted as mrkdwn
  // sections, so headings, **bold**, lists and links showed up as literal syntax.
  const build = (textContent: string, overrides: Partial<AgentResponse> = {}) =>
    buildCompletionBlocks(
      "sess-1",
      { ...BASE_RESPONSE, textContent, ...overrides },
      BASE_CONTEXT,
      "https://inspect.example.com"
    );
  const markdownBlocks = (blocks: ReturnType<typeof buildCompletionBlocks>) =>
    blocks.filter((block) => block.type === "markdown");
  const fenceCount = (text: string) => (text.match(/```/g) ?? []).length;

  it("sends a reply within the limit unchanged as one markdown block", () => {
    const textContent =
      "## Should fix\n\n**1. Deadline** can be bypassed\n\n- point [docs](https://x.dev)";
    expect(build(textContent)[0]).toEqual({ type: "markdown", text: textContent });
  });

  it("cuts a longer reply to one block within Slack's markdown limit, pointing to the session", () => {
    const blocks = build("p".repeat(MARKDOWN_BLOCK_MAX_CHARS * 2));
    const [response] = markdownBlocks(blocks);
    expect(markdownBlocks(blocks)).toHaveLength(1);
    expect(response.text.length).toBeLessThanOrEqual(MARKDOWN_BLOCK_MAX_CHARS);
    expect(response.text).toContain("truncated — open the session");
    expect(getActionElements(blocks).some((el) => el.action_id === "view_session")).toBe(true);
  });

  it("keeps code fences balanced when the cut lands inside a fence", () => {
    const lines = Math.ceil(MARKDOWN_BLOCK_MAX_CHARS / 10);
    const code = [
      "## Code",
      "```ts",
      ...Array.from({ length: lines }, (_, i) => `x${i} = ${i};`),
      "```",
    ];
    const [response] = markdownBlocks(build(code.join("\n")));
    expect(response.text.length).toBeLessThanOrEqual(MARKDOWN_BLOCK_MAX_CHARS);
    expect(response.text).toContain("truncated — open the session");
    expect(fenceCount(response.text) % 2).toBe(0);
  });

  it("strips broadcast mentions from replies of every length, keeping user mentions", () => {
    const mentions = "<!here> <!channel> <!everyone> <!subteam^S123|@team> cc <@U123>";
    for (const textContent of [
      mentions,
      `${mentions}\n\n${"q".repeat(MARKDOWN_BLOCK_MAX_CHARS)}`,
    ]) {
      const [response] = markdownBlocks(build(textContent));
      expect(response.text).not.toMatch(/<!(here|channel|everyone|subteam)/);
      expect(response.text).toContain("cc <@U123>");
    }
  });

  it("shows the placeholder when nothing is left after stripping broadcasts", () => {
    expect(build("<!here>")[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "_Agent completed._" },
    });
  });

  // Slack caps the text of all markdown blocks in a message together, so the reply
  // must stay the only one; assert it with every optional block populated, alongside
  // the 50-block message limit.
  it("emits one markdown block and stays within Slack's 50-block limit with every block populated", () => {
    const blocks = build("z".repeat(MARKDOWN_BLOCK_MAX_CHARS * 3), {
      artifacts: [{ type: "branch", label: "feature/x", url: "https://example.com/tree/x" }],
      toolCalls: [
        { tool: "Edit", summary: "Edit src/a.ts" },
        { tool: "Write", summary: "Write src/b.ts" },
        { tool: "Bash", summary: "Bash npm test" },
      ],
      success: false,
      error: "something went wrong",
    } as Partial<AgentResponse>);
    expect(markdownBlocks(blocks)).toHaveLength(1);
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it("still renders a placeholder for an empty response", () => {
    expect(build("   ")[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "_Agent completed._" },
    });
  });
});
