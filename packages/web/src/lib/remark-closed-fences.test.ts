import type { Code, Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { remarkClosedFences } from "./remark-closed-fences";

function codeBlocks(content: string): Code[] {
  const tree = unified().use(remarkParse).use(remarkClosedFences).parse(content);
  const codes: Code[] = [];
  function visit(node: Root | RootContent) {
    if (node.type === "code") codes.push(node);
    if ("children" in node) node.children.forEach(visit);
  }
  visit(tree);
  return codes;
}

describe("remarkClosedFences", () => {
  it.each([
    ["backticks", "```mermaid\nflowchart LR\n```"],
    ["tildes", "~~~mermaid\nflowchart LR\n~~~"],
    ["longer closing fence", "```mermaid\nflowchart LR\n````"],
    ["indented opening fence", "   ```mermaid\n   flowchart LR\n   ```"],
    ["indented closing fence", "```mermaid\nflowchart LR\n   ```\t "],
    ["CR", "```mermaid\rflowchart LR\r```"],
    ["CRLF", "```mermaid\r\nflowchart LR\r\n```"],
    ["block quote", "> ~~~mermaid\n> flowchart LR\n> ~~~"],
    ["unordered list", "- item\n\n  ```mermaid\n  flowchart LR\n  ```"],
    ["ordered list", "1. item\n\n   ```mermaid\n   flowchart LR\n   ```"],
    ["nested containers", "> - item\n>\n>   ```mermaid\n>   flowchart LR\n>   ```"],
  ])("marks a parsed closing fence: %s", (_name, content) => {
    const codes = codeBlocks(content);
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({
      lang: "mermaid",
      value: "flowchart LR",
      data: { hProperties: { dataFenceClosed: "true" } },
    });
  });

  it.each([
    ["no closing fence", "```mermaid\nflowchart LR"],
    ["four-space indentation", "```mermaid\nflowchart LR\n    ```"],
    ["tab indentation", "```mermaid\nflowchart LR\n\t```"],
    ["stray quote marker", "```mermaid\nflowchart LR\n> ```"],
    ["leading NBSP", "```mermaid\nflowchart LR\n\u00a0```"],
    ["trailing NBSP", "```mermaid\nflowchart LR\n```\u00a0"],
    ["short closing fence", "````mermaid\nflowchart LR\n```"],
    ["different closing marker", "```mermaid\nflowchart LR\n~~~"],
    ["trailing text", "```mermaid\nflowchart LR\n``` extra"],
    ["container ended without closing", "> ```mermaid\n> flowchart LR\n\nOutside"],
    ["indented code", "    flowchart LR"],
  ])("does not mark an unclosed fence: %s", (_name, content) => {
    const codes = codeBlocks(content);
    expect(codes).toHaveLength(1);
    expect(codes[0].data?.hProperties?.dataFenceClosed).toBeUndefined();
  });

  it("preserves code values and metadata without replacing the default exit handler", () => {
    const codes = codeBlocks("```mermaid title=diagram\nflowchart LR\n  A --> B\n```");
    expect(codes[0]).toMatchObject({
      lang: "mermaid",
      meta: "title=diagram",
      value: "flowchart LR\n  A --> B",
      data: { hProperties: { dataFenceClosed: "true" } },
    });
  });

  it("tracks each code node separately, including across repeated parses", () => {
    const processor = unified().use(remarkParse).use(remarkClosedFences);
    const content = "```js\nfirst\n```\n\n```mermaid\nsecond";
    for (let i = 0; i < 2; i++) {
      const codes = processor.parse(content).children.filter((node) => node.type === "code");
      expect(codes).toHaveLength(2);
      expect(codes[0].value).toBe("first");
      expect(codes[0].data?.hProperties?.dataFenceClosed).toBe("true");
      expect(codes[1].value).toBe("second");
      expect(codes[1].data?.hProperties?.dataFenceClosed).toBeUndefined();
    }
  });
});
