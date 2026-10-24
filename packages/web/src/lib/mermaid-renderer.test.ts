// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { MAX_MERMAID_SOURCE_LENGTH } from "./mermaid-renderer-protocol";
import { renderMermaid } from "./mermaid-svg-renderer";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
    mermaidAPI: { getDiagramFromText: vi.fn(async () => ({ db: {} })) },
  },
}));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>Diagram</text></svg>';
beforeEach(() => {
  vi.mocked(mermaid.render).mockResolvedValue({ svg, diagramType: "flowchart-v2" });
});
afterEach(() => vi.clearAllMocks());

describe("isolated Mermaid SVG output", () => {
  it.each([
    '%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n A --> B',
    "---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\n A --> B",
    "flowchart LR\n" + "A".repeat(MAX_MERMAID_SOURCE_LENGTH),
  ])("rejects unsafe or unsupported source before initializing Mermaid", async (source) => {
    expect(await renderMermaid(source, false)).toBeNull();
    expect(mermaid.initialize).not.toHaveBeenCalled();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("sanitizes only diagram SVG and returns an inert image with reserved dimensions", async () => {
    vi.mocked(mermaid.render).mockResolvedValueOnce({
      diagramType: "flowchart-v2",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" onload="alert(1)">
    <script>alert(1)</script>
    <a href="javascript:alert(1)"><text>click</text></a>
    <animateMotion dur="1s" /><animateColor attributeName="fill" />
    <animate attributeName="href" values="javascript:alert(1)" /><text onclick="alert(1)">safe</text>
    <style>text { fill: red; }</style></svg>`,
    });
    const image = await renderMermaid("flowchart LR\n A --> B", false);
    expect(image).toMatchObject({ width: 200, height: 100 });
    expect(image!.src).toMatch(/^data:image\/svg\+xml/);
    const clean = decodeURIComponent(image!.src.split(",")[1]);
    expect(clean).not.toMatch(/script|foreignObject|<a[\s>]|<image|<animate|onload|onclick|href=/i);
    expect(clean).toContain("<text>safe</text>");
    expect(clean).toContain("<style>");
    expect(document.body.children).toHaveLength(0);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        htmlLabels: false,
        startOnLoad: false,
        suppressErrorRendering: true,
      })
    );
  });

  it.each(["foreignObject", "image"])(
    "falls back when sanitization removes %s content",
    async (tag) => {
      vi.mocked(mermaid.render).mockResolvedValueOnce({
        diagramType: "sequence",
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><${tag}>Meaningful content</${tag}></svg>`,
      });
      expect(await renderMermaid("sequenceDiagram\n A->>B: Label", false)).toBeNull();
    }
  );

  it("cleans failed render hosts and can render the next theme", async () => {
    const order: string[] = [];
    vi.mocked(mermaid.initialize).mockImplementation((config) => {
      order.push(config!.theme!);
    });
    vi.mocked(mermaid.render).mockImplementationOnce(async () => {
      order.push("render light");
      throw new Error("bad");
    });
    expect(await renderMermaid("invalid", false)).toBeNull();
    expect(await renderMermaid("sequenceDiagram\n A->>B: Good", true)).not.toBeNull();
    expect(order).toEqual(["default", "render light", "dark"]);
    expect(document.body.children).toHaveLength(0);
  });

  it.each(["<svg/>", "<html>not SVG</html>", '<svg viewBox="0 0 NaN 10"/>'])(
    "falls back for unusable renderer output",
    async (output) => {
      vi.mocked(mermaid.render).mockResolvedValueOnce({ svg: output, diagramType: "flowchart-v2" });
      expect(await renderMermaid("flowchart LR\n A --> B", false)).toBeNull();
    }
  );
});
