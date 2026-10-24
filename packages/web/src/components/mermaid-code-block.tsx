"use client";

import { cloneElement, createContext, useContext, useEffect, useState } from "react";
import type { ComponentPropsWithoutRef, ReactElement } from "react";
import type { ExtraProps } from "react-markdown";
import { useTheme } from "next-themes";
import type { MermaidImage } from "@/lib/mermaid-renderer";

export const MermaidMarkdownContext = createContext(false);
const CODE_BLOCK_CLASS = "not-prose max-w-full overflow-x-auto text-sm leading-relaxed rounded";
const MAX_CACHED_DIAGRAMS = 32;

// Completed-image eviction must not lose ownership of a still-pending request.
const diagrams = new Map<string, MermaidImage | null>();
const pendingDiagrams = new Map<string, Promise<MermaidImage | null>>();
function diagramKey(source: string, dark: boolean) {
  return JSON.stringify([dark, source]);
}
function loadDiagram(source: string, dark: boolean): Promise<MermaidImage | null> {
  const key = diagramKey(source, dark);
  if (diagrams.has(key)) return Promise.resolve(diagrams.get(key)!);
  const pending = pendingDiagrams.get(key);
  if (pending) return pending;
  const request = import("@/lib/mermaid-renderer")
    .then(({ renderMermaid }) => renderMermaid(source, dark))
    .catch(() => null)
    .then((image) => {
      pendingDiagrams.delete(key);
      diagrams.set(key, image);
      if (diagrams.size > MAX_CACHED_DIAGRAMS) diagrams.delete(diagrams.keys().next().value!);
      return image;
    });
  pendingDiagrams.set(key, request);
  return request;
}

function MermaidDiagram({
  source,
  fallback,
}: {
  source: string;
  fallback: ReactElement<ComponentPropsWithoutRef<"pre">>;
}) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const key = diagramKey(source, dark);
  const [result, setResult] = useState(() => ({
    source,
    image: diagrams.get(key),
  }));
  const [failedImage, setFailedImage] = useState<string>();

  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    let cancelled = false;
    void loadDiagram(source, dark).then((image) => {
      if (!cancelled) setResult({ source, image });
    });
    return () => {
      cancelled = true;
    };
  }, [source, dark, resolvedTheme]);

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
        {cloneElement(fallback, { tabIndex: 0 })}
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
  const enabled = useContext(MermaidMarkdownContext);
  const fallback = (
    <pre className={CODE_BLOCK_CLASS} {...props}>
      {children}
    </pre>
  );
  const code = node?.children[0];
  if (
    !enabled ||
    code?.type !== "element" ||
    code.tagName !== "code" ||
    code.properties.dataFenceClosed !== "true" ||
    !Array.isArray(code.properties.className) ||
    !code.properties.className.includes("language-mermaid")
  )
    return fallback;

  // Mermaid is unknown to the highlighter, so its contents remain one plain text node.
  const source = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
  return <MermaidDiagram source={source} fallback={fallback} />;
}
