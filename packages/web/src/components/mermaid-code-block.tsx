"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { ExtraProps } from "react-markdown";
import { useTheme } from "next-themes";
import type { MermaidImage } from "@/lib/mermaid-renderer";

export const MermaidMarkdownContext = createContext({ enabled: false, content: "" });
const CODE_BLOCK_CLASS = "not-prose max-w-full overflow-x-auto text-sm leading-relaxed rounded";
const MAX_CACHED_DIAGRAMS = 32;

interface CachedDiagram {
  image?: MermaidImage | null;
  pending: Promise<MermaidImage | null>;
}

// Cache promises as well as results so virtual rows can remount without duplicate work.
// Bounded to avoid retaining every source and SVG from a long-running session.
const diagrams = new Map<string, CachedDiagram>();
function diagramKey(source: string, dark: boolean) {
  return JSON.stringify([dark, source]);
}
function loadDiagram(source: string, dark: boolean): CachedDiagram {
  const key = diagramKey(source, dark);
  const cached = diagrams.get(key);
  if (cached) return cached;
  const entry: CachedDiagram = {
    pending: import("@/lib/mermaid-renderer")
      .then(({ renderMermaid }) => renderMermaid(source, dark))
      .catch(() => null)
      .then((image) => {
        entry.image = image;
        return image;
      }),
  };
  diagrams.set(key, entry);
  if (diagrams.size > MAX_CACHED_DIAGRAMS) diagrams.delete(diagrams.keys().next().value!);
  return entry;
}

function MermaidDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const key = diagramKey(source, dark);
  const [result, setResult] = useState(() => ({
    source,
    image: diagrams.get(key)?.image,
  }));
  const [failedImage, setFailedImage] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const entry = loadDiagram(source, dark);
    void entry.pending.then((image) => {
      if (!cancelled) setResult({ source, image });
    });
    return () => {
      cancelled = true;
    };
  }, [source, dark]);

  // Keep the last diagram during a theme change, but never show an old source's image.
  const image = result.source === source ? result.image : undefined;
  if (!image || failedImage === image.src) return fallback;
  const title = /^\s*accTitle\s*:\s*(.+)$/m.exec(source)?.[1];
  return (
    <figure className="not-prose my-3 min-w-0 max-w-full">
      <div
        className="max-h-[32rem] max-w-full overflow-auto rounded border border-border p-3"
        tabIndex={0}
      >
        {/* SVG is an inert image, not inline DOM. Source remains available below. */}
        <img
          src={image.src}
          alt={title || `Mermaid diagram: ${source.trim().slice(0, 160)}`}
          width={image.width}
          height={image.height}
          className="m-0 block max-w-none"
          onError={() => setFailedImage(image.src)}
        />
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          View diagram source
        </summary>
        {fallback}
      </details>
    </figure>
  );
}

/** Stable component identity keeps a completed diagram mounted as more tokens arrive. */
export function MarkdownPre({
  children,
  node,
  ...props
}: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const { enabled, content } = useContext(MermaidMarkdownContext);
  const fallback = (
    <pre className={CODE_BLOCK_CLASS} tabIndex={0} {...props}>
      {children}
    </pre>
  );
  const code = node?.children[0];
  if (
    !enabled ||
    code?.type !== "element" ||
    code.tagName !== "code" ||
    !Array.isArray(code.properties.className) ||
    !code.properties.className.includes("language-mermaid")
  )
    return fallback;

  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (start === undefined || end === undefined) return fallback;
  const lines = content.slice(start, end).split("\n");
  const opening = /^(`{3,}|~{3,})/.exec(lines[0]);
  if (!opening || lines.length < 2) return fallback;
  const fence = opening[1];
  // CommonMark accepts unclosed fences; do not process those during streaming.
  const closing = new RegExp(`^[\\s>]*${fence[0]}{${fence.length},}\\s*$`);
  if (!closing.test(lines[lines.length - 1])) return fallback;
  // Mermaid is unknown to the highlighter, so its contents remain one plain text node.
  const source = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
  return <MermaidDiagram source={source} fallback={fallback} />;
}
