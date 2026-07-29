import { describe, expect, it } from "vitest";
import { buildCompletionBlocks, splitIntoSlackSections } from "./blocks";
import type { AgentResponse, SlackCallbackContext } from "../types";

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

  it("preserves whitespace exactly across section boundaries", () => {
    const textContent = `\n  alpha\n\n\n\n\nbeta\n\n${"x".repeat(4000)}  \n`;
    const sections = splitIntoSlackSections(textContent);

    expect(sections.join("")).toBe(textContent);
  });

  it("keeps Unicode code points intact across hard section boundaries", () => {
    const textContent = `${"a".repeat(2999)}😀${"b".repeat(10)}`;
    const sections = splitIntoSlackSections(textContent);

    expect(sections.join("")).toBe(textContent);
    for (const section of sections) {
      const firstCodeUnit = section.charCodeAt(0);
      const lastCodeUnit = section.charCodeAt(section.length - 1);
      expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
      expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
    }
  });

  it("rejects a section budget that cannot fit the next Unicode code point", () => {
    expect(() => splitIntoSlackSections("😀", 1)).toThrow(
      new RangeError("Section budget is too small to fit the next Unicode code point")
    );
  });

  it("keeps Unicode code points intact when adding the truncation marker", () => {
    for (let prefixLength = 2900; prefixLength <= 3000; prefixLength += 1) {
      const textContent = `${"a".repeat(prefixLength)}😀${"b".repeat(4000)}\n\nmore`;
      const [section] = splitIntoSlackSections(textContent, 3000, 1);
      const markerIndex = section.indexOf("_...truncated");
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      const content = section.slice(0, markerIndex).trimEnd();
      const lastCodeUnit = content.charCodeAt(content.length - 1);
      expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
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

  it("balances fences that open and close on the same line", () => {
    const fence = "```";
    const sections = splitIntoSlackSections(`${fence}code${fence}\n${"after ".repeat(700)}`);

    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect((section.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  // The two checks above pass on fence-free and short-line input respectively, so
  // neither exercises a split *inside* a fence — which is where the section repair
  // adds characters after the fit check and where the hard slice drops them.
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

  it("loses no characters when hard-slicing inside a fence", () => {
    const payload = "b".repeat(7000);
    const sections = splitIntoSlackSections(`\`\`\`js\n${payload}\n\`\`\``);
    const recovered = sections
      .join("")
      .split("```")
      .join("")
      .replace(/^js$/gm, "")
      .replace(/\n/g, "");
    expect(recovered).toBe(payload);
  });

  it("keeps fences balanced in the truncated final section", () => {
    const textContent = `\`\`\`ts\n${Array.from({ length: 400 }, () => "y".repeat(2900)).join("\n")}\n\`\`\``;
    const sections = splitIntoSlackSections(textContent);
    const last = sections[sections.length - 1];
    expect(last).toContain("truncated");
    expect(last.length).toBeLessThanOrEqual(3000);
    for (const section of sections) {
      expect((section.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  // The truncation cut can land inside a fence the final section both opened and
  // closed, which a trailing-fence check cannot detect. Sweep the section length
  // through the window where slicing actually happens, moving the fence across the
  // cut point, and assert the invariant holds for every shape.
  it("keeps fences balanced when the truncation cut lands inside a fence", () => {
    const fence = "```";
    for (let sectionLen = 2949; sectionLen <= 3000; sectionLen += 1) {
      for (const codeLen of [20, 45, 200]) {
        const block = `\n${fence}ts\n${"h".repeat(codeLen)}\n${fence}`;
        const fill = sectionLen - block.length;
        if (fill < 1) continue;
        const paragraphs = [
          ...Array.from({ length: 19 }, () => "f".repeat(2900)),
          "g".repeat(fill) + block,
          ...Array.from({ length: 5 }, () => "z".repeat(2900)),
        ];
        const sections = splitIntoSlackSections(paragraphs.join("\n\n"));
        const last = sections[sections.length - 1];
        expect(last).toContain("truncated");
        expect(last.length).toBeLessThanOrEqual(3000);
        expect((last.match(/```/g) ?? []).length % 2).toBe(0);
      }
    }
  });

  it("carries the fence language across a split", () => {
    const sections = splitIntoSlackSections(`\`\`\`python\n${"c".repeat(6500)}\n\`\`\``);
    expect(sections.length).toBeGreaterThan(1);
    // Every continuation section reopens the fence with its original language.
    for (const section of sections.slice(1)) {
      expect(section.startsWith("```python\n")).toBe(true);
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

describe("fence info bounding", () => {
  // Regression: `info` was captured unbounded from the fence line, so an
  // oversized fence-opener (a single ≥3000-char line beginning with ```) was
  // re-emitted by reopenPrefix on every continuation section and overflowed
  // Slack's per-section cap. Slack rejects the whole message on overflow rather
  // than trimming the block, so the cap has to hold for every input shape.
  it("keeps sections within the cap for an oversized fence-opener line", () => {
    const monsterInfo = "x".repeat(4000);
    const sections = splitIntoSlackSections(`\`\`\`${monsterInfo}\n${"c".repeat(5000)}\n\`\`\``);
    for (const section of sections) {
      expect(section.length).toBeLessThanOrEqual(3000);
    }
  });

  it("keeps only the language token when the fence line carries trailing text", () => {
    const sections = splitIntoSlackSections(
      `\`\`\`python title="a very long annotation ${"y".repeat(200)}"\n${"c".repeat(6500)}\n\`\`\``
    );
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections.slice(1)) {
      expect(section.startsWith("```python\n")).toBe(true);
    }
  });

  // The bot's review caught the original overflow by fuzzing rather than by a
  // single case, and a single case would have missed it here too.
  it("never overflows across a sweep of fence-opener and body lengths", () => {
    for (let infoLen = 0; infoLen <= 4200; infoLen += 350) {
      for (let bodyLen = 2900; bodyLen <= 6200; bodyLen += 550) {
        const text = `\`\`\`${"i".repeat(infoLen)}\n${"b".repeat(bodyLen)}\n\`\`\``;
        for (const section of splitIntoSlackSections(text)) {
          expect(section.length).toBeLessThanOrEqual(3000);
          expect((section.match(/```/g) ?? []).length % 2).toBe(0);
        }
      }
    }
  });
});
