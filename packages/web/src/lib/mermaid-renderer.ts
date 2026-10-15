// Imported only from a client effect after a complete Mermaid fence is encountered.
import mermaid from "mermaid";
import DOMPurify from "dompurify";

export interface MermaidImage {
  src: string;
  width: number;
  height: number;
}

export const MAX_MERMAID_SOURCE_LENGTH = 20_000;
let renderSequence = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

/** Inspect parsed metadata, including YAML-escaped keys, before any drawing occurs. */
function hasImageResource(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) return [...value.values()].some((item) => hasImageResource(item, seen));
  return Object.entries(value).some(
    ([key, item]) =>
      ((key === "img" || key === "icon") && Boolean(item)) ||
      (key === "shape" && item === "imageSquare") ||
      hasImageResource(item, seen)
  );
}

/** Serialize initialization + rendering: Mermaid configuration is process-global. */
export function renderMermaid(source: string, dark: boolean): Promise<MermaidImage | null> {
  const result = renderQueue.then(async () => {
    // Model-authored configuration must never override the site's renderer policy.
    // Leave directives/frontmatter readable as source rather than trying to rewrite them.
    if (
      source.length > MAX_MERMAID_SOURCE_LENGTH ||
      source.includes("%%{") ||
      // Math uses live HTML measurement even with htmlLabels disabled. Keep it as source
      // before Mermaid can insert model-authored HTML or load resources during drawing.
      source.includes("$$") ||
      /^\s*---/.test(source) ||
      // Disallow CSS resource functions/imports and escapes that could conceal them.
      /\b(?:url|image(?:-set)?)\s*\(|@import|\\/i.test(source)
    ) {
      return null;
    }

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: dark ? "dark" : "default",
      fontFamily: "Arial, sans-serif",
      maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
      maxEdges: 250,
    });
    // strict mode still draws image shapes and sequence participant icons. Parse first:
    // never let source-provided resources reach Mermaid's live-DOM drawing stage.
    const { db } = await mermaid.mermaidAPI.getDiagramFromText(source);
    if ("getData" in db && typeof db.getData === "function" && hasImageResource(db.getData()))
      return null;
    if ("getActors" in db && typeof db.getActors === "function" && hasImageResource(db.getActors()))
      return null;

    const renderId = `timeline-mermaid-${++renderSequence}`;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(renderId, source, host);
      // This SVG policy is separate from ordinary Markdown's restrictive schema.
      // The final image context also disables scripts, navigation and external resources;
      // generated SVG is never inserted into the timeline DOM or bound to callbacks.
      const clean = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: [
          "foreignObject",
          "a",
          "image",
          "script",
          "animate",
          "animateTransform",
          "animateMotion",
          "animateColor",
          "set",
        ],
        FORBID_ATTR: ["href", "xlink:href", "tabindex"],
      });
      // Stripping a label/image produces a misleading partial diagram, even if its
      // root and viewBox remain valid. Keep source primary for unsupported content.
      if (
        DOMPurify.removed.some(
          (item) =>
            "element" in item &&
            ["foreignobject", "image"].includes(item.element?.nodeName.toLowerCase() ?? "")
        )
      )
        return null;
      const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
      const root = doc.documentElement;
      if (root.localName !== "svg" || doc.querySelector("parsererror")) return null;
      const viewBox = root
        .getAttribute("viewBox")
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
      const width = viewBox?.[2];
      const height = viewBox?.[3];
      if (
        !width ||
        !height ||
        width <= 0 ||
        height <= 0 ||
        !Number.isFinite(width) ||
        !Number.isFinite(height)
      )
        return null;
      return {
        src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`,
        width,
        height,
      };
    } finally {
      // Covers failures in drawing, sanitizing, and serializing as well as parsing.
      host.remove();
    }
  });
  // Catch both rendering failures and queue failures; no rejected promises escape.
  const safeResult = result.catch(() => null);
  renderQueue = safeResult;
  return safeResult;
}
