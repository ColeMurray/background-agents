"use client";

import { useTheme } from "next-themes";
import { useEffect, useId, useState } from "react";

type MermaidProps = {
  /** Mermaid diagram source. */
  chart: string;
  /** Caption rendered under the diagram and used as its accessible name. */
  caption?: string;
};

const lightVariables = {
  background: "#f8f8f6",
  primaryColor: "#f2f1ed",
  primaryTextColor: "#1a1a1a",
  primaryBorderColor: "#8b7355",
  secondaryColor: "#eceae4",
  tertiaryColor: "#f8f8f6",
  lineColor: "#6f5a41",
  textColor: "#1a1a1a",
  edgeLabelBackground: "#f8f8f6",
  clusterBkg: "#f0efeb",
  clusterBorder: "rgba(26, 26, 26, 0.2)",
  noteBkgColor: "#eceae4",
  noteBorderColor: "#8b7355",
  actorBkg: "#f2f1ed",
  actorBorder: "#8b7355",
  labelBoxBkgColor: "#f0efeb",
  labelBoxBorderColor: "#8b7355",
  signalColor: "#1a1a1a",
  signalTextColor: "#1a1a1a",
  activationBkgColor: "#eceae4",
  activationBorderColor: "#8b7355",
};

const darkVariables = {
  background: "#171715",
  primaryColor: "#20201d",
  primaryTextColor: "#f8f8f6",
  primaryBorderColor: "#b89b78",
  secondaryColor: "#252521",
  tertiaryColor: "#171715",
  lineColor: "#d7c2a8",
  textColor: "#f8f8f6",
  edgeLabelBackground: "#171715",
  clusterBkg: "#22221f",
  clusterBorder: "rgba(248, 248, 246, 0.2)",
  noteBkgColor: "#252521",
  noteBorderColor: "#b89b78",
  actorBkg: "#20201d",
  actorBorder: "#b89b78",
  labelBoxBkgColor: "#22221f",
  labelBoxBorderColor: "#b89b78",
  signalColor: "#f8f8f6",
  signalTextColor: "#f8f8f6",
  activationBkgColor: "#252521",
  activationBorderColor: "#b89b78",
};

export function Mermaid({ chart, caption }: MermaidProps) {
  const reactId = useId();
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const isDark = resolvedTheme === "dark";
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;

    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
          themeVariables: { ...(isDark ? darkVariables : lightVariables), fontSize: "14px" },
          flowchart: { curve: "basis", padding: 12 },
          sequence: { mirrorActors: false },
        });
        const result = await mermaid.render(renderId, chart.trim());
        if (!cancelled) {
          setSvg(result.svg);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [chart, reactId, resolvedTheme]);

  return (
    <figure className="not-prose my-6 overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div
        aria-label={caption}
        className="w-full overflow-x-auto p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        role="img"
      >
        {svg ? (
          <div className="w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : error ? (
          <pre className="w-full overflow-x-auto text-xs text-fd-muted-foreground">
            {chart.trim()}
          </pre>
        ) : (
          <div aria-hidden className="h-40 w-full animate-pulse rounded bg-fd-muted" />
        )}
      </div>
      {caption ? (
        <figcaption className="border-t border-fd-border px-4 py-2 text-sm text-fd-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
