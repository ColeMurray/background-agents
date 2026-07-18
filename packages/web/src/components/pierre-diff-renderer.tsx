"use client";

import { PatchDiff, type VirtualFileMetrics } from "@pierre/diffs/react";
import type { CSSProperties } from "react";
import type { DiffStyle } from "@/hooks/use-session-diff-preferences";

const COMPACT_DIFF_METRICS: VirtualFileMetrics = {
  hunkLineCount: 50,
  lineHeight: 18,
  diffHeaderHeight: 44,
  spacing: 8,
};

const COMPACT_DIFF_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
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
  return (
    <PatchDiff
      patch={patch}
      metrics={COMPACT_DIFF_METRICS}
      style={COMPACT_DIFF_STYLE}
      options={{
        diffStyle,
        overflow: wrap ? "wrap" : "scroll",
        themeType,
        hunkSeparators: "line-info",
        expandUnchanged: false,
        disableFileHeader: true,
        stickyHeader: false,
      }}
    />
  );
}
