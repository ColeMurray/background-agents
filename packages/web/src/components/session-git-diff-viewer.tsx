"use client";

import ReactDiffViewer from "react-diff-viewer-continued";

interface SessionGitDiffViewerProps {
  filename: string | null;
  rawDiff: string | null;
  splitView: boolean;
}

function patchToOldNew(rawDiff: string): { oldValue: string; newValue: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of rawDiff.split("\n")) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
      continue;
    }
  }

  return {
    oldValue: oldLines.join("\n"),
    newValue: newLines.join("\n"),
  };
}

const diffStyles = {
  variables: {
    light: {
      diffViewerBackground: "var(--card)",
      diffViewerColor: "var(--foreground)",
      addedBackground: "var(--success-muted)",
      addedColor: "var(--foreground)",
      removedBackground: "var(--destructive-muted)",
      removedColor: "var(--foreground)",
      wordAddedBackground: "var(--success-muted)",
      wordRemovedBackground: "var(--destructive-muted)",
      addedGutterBackground: "var(--success-muted)",
      removedGutterBackground: "var(--destructive-muted)",
      gutterBackground: "var(--card)",
      gutterBackgroundDark: "var(--card)",
      highlightBackground: "var(--accent-muted)",
      highlightGutterBackground: "var(--accent-muted)",
      codeFoldBackground: "var(--muted)",
      codeFoldGutterBackground: "var(--muted)",
      codeFoldContentColor: "var(--muted-foreground)",
      emptyLineBackground: "var(--card)",
      gutterColor: "var(--secondary-foreground)",
      addedGutterColor: "var(--foreground)",
      removedGutterColor: "var(--foreground)",
    },
    dark: {
      diffViewerBackground: "var(--card)",
      diffViewerColor: "var(--foreground)",
      addedBackground: "var(--success-muted)",
      addedColor: "var(--foreground)",
      removedBackground: "var(--destructive-muted)",
      removedColor: "var(--foreground)",
      wordAddedBackground: "var(--success-muted)",
      wordRemovedBackground: "var(--destructive-muted)",
      addedGutterBackground: "var(--success-muted)",
      removedGutterBackground: "var(--destructive-muted)",
      gutterBackground: "var(--card)",
      gutterBackgroundDark: "var(--card)",
      highlightBackground: "var(--accent-muted)",
      highlightGutterBackground: "var(--accent-muted)",
      codeFoldBackground: "var(--muted)",
      codeFoldGutterBackground: "var(--muted)",
      codeFoldContentColor: "var(--muted-foreground)",
      emptyLineBackground: "var(--card)",
      gutterColor: "var(--secondary-foreground)",
      addedGutterColor: "var(--foreground)",
      removedGutterColor: "var(--foreground)",
    },
  },
} as const;

export function SessionGitDiffViewer({ filename, rawDiff, splitView }: SessionGitDiffViewerProps) {
  if (!filename) {
    return <p className="text-sm text-muted-foreground p-4">Select a file to view diff.</p>;
  }
  if (!rawDiff) {
    return <p className="text-sm text-muted-foreground p-4">No diff available for {filename}.</p>;
  }

  const { oldValue, newValue } = patchToOldNew(rawDiff);

  return (
    <div className="h-full min-h-0 border-l border-border-muted flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-border-muted text-sm text-muted-foreground truncate flex-shrink-0">
        {filename}
      </div>
      <div className="session-git-diff-viewer flex-1 min-h-0 overflow-auto">
        <ReactDiffViewer
          oldValue={oldValue}
          newValue={newValue}
          splitView={splitView}
          showDiffOnly={false}
          hideLineNumbers={false}
          styles={diffStyles}
        />
      </div>
    </div>
  );
}
