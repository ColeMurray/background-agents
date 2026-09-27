"use client";

import { ImageZoom } from "fumadocs-ui/components/image-zoom";
import { useTheme } from "next-themes";
import { useEffect, useId, useState } from "react";

import { brand, withAlpha } from "@/lib/brand";

type MermaidProps = {
  /** Mermaid diagram source. */
  chart: string;
};

/** Every render attempt needs its own id: Mermaid removes an existing element with that id first. */
let renderSequence = 0;

/**
 * The chart's `accTitle:` line. A ```mermaid fence carries no props of its own,
 * so this is the only way a diagram can name itself.
 */
function accessibleTitle(chart: string): string | undefined {
  return /^\s*accTitle\s*:\s*(.+?)\s*$/m.exec(chart)?.[1];
}

/** Mermaid's theme variables for one color scheme, named in the site's own tokens. */
function themeVariables(scheme: "light" | "dark") {
  const { background, foreground, muted, card, secondary, accentForeground, ring } = brand[scheme];
  return {
    background,
    primaryColor: card,
    primaryTextColor: foreground,
    primaryBorderColor: ring,
    secondaryColor: secondary,
    tertiaryColor: background,
    lineColor: accentForeground,
    textColor: foreground,
    edgeLabelBackground: background,
    clusterBkg: muted,
    clusterBorder: withAlpha(foreground, 0.2),
    noteBkgColor: secondary,
    noteBorderColor: ring,
    actorBkg: card,
    actorBorder: ring,
    labelBoxBkgColor: muted,
    labelBoxBorderColor: ring,
    signalColor: foreground,
    signalTextColor: foreground,
    activationBkgColor: secondary,
    activationBorderColor: ring,
  };
}

/**
 * Mermaid prefixes every inner id with the SVG's own id. The zoomed copy renames ids by
 * replacing `#<id>` throughout its stylesheet, which would also rewrite references such as
 * `url(#<id>-gradient)`. A root id that no inner id starts with keeps those references intact.
 */
function withDistinctRootId(svg: string, id: string): string {
  return svg.replace(new RegExp(`(#|id=")${id}(?![\\w-])`, "g"), `$1${id}-root`);
}

export function Mermaid({ chart }: MermaidProps) {
  const reactId = useId();
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const label = accessibleTitle(chart);

  useEffect(() => {
    let cancelled = false;
    const scheme = resolvedTheme === "dark" ? "dark" : "light";
    renderSequence += 1;
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}-${renderSequence}`;

    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
          themeVariables: { ...themeVariables(scheme), fontSize: "14px" },
          flowchart: { curve: "basis", padding: 12 },
          sequence: { mirrorActors: false },
        });
        const result = await mermaid.render(renderId, chart.trim());
        if (!cancelled) {
          setSvg(withDistinctRootId(result.svg, renderId));
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Drop the previous render: a re-render that failed (a theme switch, or
        // an edited chart in dev) would otherwise keep showing a diagram that no
        // longer matches the page, and hide the fallback below.
        setSvg(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [chart, reactId, resolvedTheme]);

  return (
    <figure className="not-prose my-6 overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div
        aria-label={label}
        className="w-full overflow-x-auto p-4 [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full [&_svg]:cursor-zoom-in"
        role={label ? "img" : undefined}
      >
        {svg ? (
          // The zoom binds to the SVG element it finds on mount, so a re-render remounts it.
          <ImageZoom key={svg}>
            <span className="block w-full" dangerouslySetInnerHTML={{ __html: svg }} />
          </ImageZoom>
        ) : error ? (
          <pre className="w-full overflow-x-auto text-xs text-fd-muted-foreground">
            {chart.trim()}
          </pre>
        ) : (
          <div aria-hidden className="h-40 w-full animate-pulse rounded bg-fd-muted" />
        )}
      </div>
    </figure>
  );
}
