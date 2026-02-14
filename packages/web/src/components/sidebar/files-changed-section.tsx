"use client";

import { formatFilePath, formatDiffStat } from "@/lib/format";
import type { FileChange } from "@/types/session";

interface FilesChangedSectionProps {
  files: FileChange[];
}

export function FilesChangedSection({ files }: FilesChangedSectionProps) {
  if (files.length === 0) return null;

  return (
    <div className="space-y-2">
      {files.map((file, index) => {
        const { display, full } = formatFilePath(file.filename);
        const { additions, deletions } = formatDiffStat(file.additions, file.deletions);

        return (
          <div
            key={`${file.filename}-${index}`}
            className="flex items-center justify-between gap-2 text-sm"
            title={full}
          >
            <span className="text-ash-900 truncate flex-1">{display}</span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-mint-500 font-mono text-xs">{additions}</span>
              <span className="text-lava-600 font-mono text-xs">{deletions}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
