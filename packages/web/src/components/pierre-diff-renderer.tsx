"use client";

import { isHighlighterLoaded, preloadHighlighter } from "@pierre/diffs";
import { PatchDiff, type VirtualFileMetrics } from "@pierre/diffs/react";
import { useEffect, useState, type CSSProperties } from "react";
import type { DiffStyle } from "@/hooks/use-session-diff-preferences";

const REVIEW_THEMES = { light: "github-light", dark: "github-dark" } as const;

const REVIEW_DIFF_METRICS: VirtualFileMetrics = {
  hunkLineCount: 50,
  lineHeight: 20,
  diffHeaderHeight: 44,
  spacing: 8,
};

// Code sits on the app background and uses the app's semantic change colors.
const REVIEW_DIFF_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "20px",
  "--diffs-bg": "var(--background)",
  "--diffs-fg": "var(--foreground)",
  "--diffs-fg-number-override": "var(--muted-foreground)",
  "--diffs-bg-separator-override": "var(--muted)",
  "--diffs-addition-color-override": "var(--success)",
  "--diffs-deletion-color-override": "var(--destructive)",
  "--diffs-modified-color-override": "var(--info)",
};

export default function PierreDiffRenderer({
  patch,
  diffStyle,
  wrap,
  themeType,
}: {
  patch: string;
  diffStyle: DiffStyle;
  wrap: boolean;
  themeType: "light" | "dark";
}) {
  // Once the shared highlighter is up, later renderers mount highlighted straight away.
  const [highlighterReady, setHighlighterReady] = useState(isHighlighterLoaded);

  useEffect(() => {
    if (highlighterReady) return;
    let active = true;
    // Mounting the renderer while the highlighter initializes can leave its shadow
    // root empty (seen under React Strict Mode), so load it with the themes first.
    preloadHighlighter({ themes: Object.values(REVIEW_THEMES), langs: ["text"] }).then(
      () => {
        if (active) setHighlighterReady(true);
      },
      () => {
        // Keep the raw patch readable if highlighting cannot initialize.
      }
    );
    return () => {
      active = false;
    };
  }, [highlighterReady]);

  if (!highlighterReady) {
    return (
      <pre
        aria-label="Raw diff"
        className={`overflow-auto p-4 font-mono text-xs leading-5 ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}
      >
        {patch}
      </pre>
    );
  }

  return (
    <div className="box-border min-w-0 w-full">
      <PatchDiff
        patch={patch}
        metrics={REVIEW_DIFF_METRICS}
        style={REVIEW_DIFF_STYLE}
        options={{
          diffStyle,
          overflow: wrap ? "wrap" : "scroll",
          themeType,
          theme: REVIEW_THEMES,
          hunkSeparators: "line-info",
          expandUnchanged: false,
          disableFileHeader: true,
          stickyHeader: false,
        }}
      />
    </div>
  );
}
