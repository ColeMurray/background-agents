// Only the isolated renderer entry imports this module, never the application bundle.
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { MAX_MERMAID_SOURCE_LENGTH, type MermaidImage } from "./mermaid-renderer-protocol";
let renderSequence = 0;

/** The parent serializes requests before entering this realm. */
export async function renderMermaid(source: string, dark: boolean): Promise<MermaidImage | null> {
  try {
    // Model-authored configuration must never override the site's renderer policy.
    // Leave directives/frontmatter readable as source rather than trying to rewrite them.
    if (
      source.length > MAX_MERMAID_SOURCE_LENGTH ||
      source.includes("%%{") ||
      /^\s*---/.test(source)
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
    const renderId = `timeline-mermaid-${++renderSequence}`;
    const originalChildren = new Set(document.body.children);
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
      // Some diagrams create measurement/layout nodes outside the supplied host.
      // This document belongs exclusively to the renderer, so remove all new nodes.
      for (const child of [...document.body.children]) {
        if (!originalChildren.has(child)) child.remove();
      }
    }
  } catch {
    return null;
  }
}
