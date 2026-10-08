import { describe, expect, it } from "vitest";
import { markdownToMrkdwn } from "./mrkdwn";

describe("markdownToMrkdwn", () => {
  it("converts the common constructs agents write", () => {
    const markdown = [
      "# Heading",
      "",
      "- **bold** and *italic* and ~~gone~~",
      "- [link](https://example.com?a=1&b=2)",
      "",
      "> quoted",
      "",
      "```python",
      "if a < b and c > d:",
      '    print("*literal*")',
      "```",
      "",
      "Use `x < y & z`.",
    ].join("\n");

    expect(markdownToMrkdwn(markdown)).toBe(
      [
        "*Heading*",
        "",
        "• *bold* and _italic_ and ~gone~",
        "• <https://example.com?a=1&amp;b=2|link>",
        "",
        "> quoted",
        "",
        "```",
        "if a &lt; b and c &gt; d:",
        '    print("*literal*")',
        "```",
        "",
        "Use `x &lt; y &amp; z`.",
      ].join("\n")
    );
  });

  it("numbers ordered lists from their start value", () => {
    expect(markdownToMrkdwn("3. third\n4. fourth")).toBe("3. third\n4. fourth");
  });

  it("indents nested list items", () => {
    expect(markdownToMrkdwn("- outer\n  - inner")).toBe("• outer\n    • inner");
  });

  it("renders bold text that labels a list item", () => {
    expect(markdownToMrkdwn("- **Fix:** kill the group")).toBe("• *Fix:* kill the group");
  });

  it("renders headings of every level as bold lines", () => {
    expect(markdownToMrkdwn("## Should fix\n\nbody")).toBe("*Should fix*\n\nbody");
  });

  it("escapes raw HTML and control sequences instead of passing them through", () => {
    expect(markdownToMrkdwn("<div>hi</div> <!channel>")).toBe(
      "&lt;div&gt;hi&lt;/div&gt; &lt;!channel&gt;"
    );
  });

  it("keeps tables readable as preformatted text", () => {
    expect(markdownToMrkdwn("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
      "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```"
    );
  });

  it("renders a horizontal rule as a divider line", () => {
    expect(markdownToMrkdwn("above\n\n---\n\nbelow")).toBe("above\n\n———\n\nbelow");
  });
});
