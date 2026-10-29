// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderMermaid } from "./mermaid-svg-renderer";

// SVG correctness only. Real CSP/origin isolation is tested by test:mermaid-browser.
beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 80, height: 30 }),
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value: () => 80,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each([
  "sequenceDiagram\n Alice->>Bob: Hello",
  'flowchart LR\n A@{ shape: rect, label: "Safe" } --> B',
  'pie\n "Tests": 10',
])("renders resource-free diagrams as inert images: %s", async (source) => {
  const image = await renderMermaid(source, false);
  expect(image?.src).toMatch(/^data:image\/svg\+xml/);
  expect(image?.width).toBeGreaterThan(0);
  expect(image?.height).toBeGreaterThan(0);
  expect(document.body.children).toHaveLength(0);
});

it("falls back rather than returning a partial diagram when math requires HTML", async () => {
  expect(await renderMermaid("sequenceDiagram\n Alice->>Bob: $$x^2$$", false)).toBeNull();
  expect(document.body.children).toHaveLength(0);
});

it("falls back for architecture text that requires foreignObject", async () => {
  expect(await renderMermaid('architecture-beta\n service a "Plain text" [A]', false)).toBeNull();
  expect(document.body.children).toHaveLength(0);
});
