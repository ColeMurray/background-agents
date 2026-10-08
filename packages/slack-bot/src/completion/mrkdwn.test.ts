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

  it("links only web and mailto destinations so a link can't become a mention", () => {
    expect(markdownToMrkdwn("[here](!here) [you](@U123) [chan](#C123)")).toBe(
      "here (!here) you (@U123) chan (#C123)"
    );
    expect(markdownToMrkdwn("![pic](!channel) [x](javascript:alert(1))")).toBe(
      "pic (!channel) x (javascript:alert(1))"
    );
    expect(markdownToMrkdwn("[file](src/a.ts) [mail](mailto:a@b.co)")).toBe(
      "file (src/a.ts) <mailto:a@b.co|mail>"
    );
  });

  it("decodes entities in link destinations before escaping them once", () => {
    expect(markdownToMrkdwn("[b](https://x.com/?a=1&amp;b=2)")).toBe(
      "<https://x.com/?a=1&amp;b=2|b>"
    );
    expect(markdownToMrkdwn("[b](https://x.com/&lt;!here&gt;)")).toBe(
      "b (https://x.com/&lt;!here&gt;)"
    );
  });

  it("renders an image inside a link as its alt text so links don't nest", () => {
    expect(markdownToMrkdwn("[![CI](https://a.com/badge.png)](https://b.com)")).toBe(
      "<https://b.com|CI>"
    );
  });

  it("falls back to the destination when a link has no label", () => {
    expect(markdownToMrkdwn("[](https://x.com) [](src/a.ts)")).toBe(
      "<https://x.com|https://x.com> src/a.ts"
    );
  });

  it("shows entities inside inline code literally and decodes them in prose", () => {
    expect(markdownToMrkdwn("`&lt;div&gt;` AT&amp;T")).toBe("`&amp;lt;div&amp;gt;` AT&amp;T");
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
