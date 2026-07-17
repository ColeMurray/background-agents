"use client";

import { PatchDiff } from "@pierre/diffs/react";
import type { DiffStyle } from "@/hooks/use-session-diff-preferences";

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
