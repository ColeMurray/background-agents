"use client";

import { FileIcon } from "@/components/ui/icons";
import type { Artifact } from "@/types/session";

interface FileArtifactCardProps {
  sessionId: string;
  artifact: Artifact;
}

function formatBytes(sizeBytes: number | undefined): string | null {
  if (!Number.isFinite(sizeBytes) || !sizeBytes || sizeBytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function FileArtifactCard({ sessionId, artifact }: FileArtifactCardProps) {
  const filename = artifact.metadata?.filename || "Download file";
  const caption = artifact.metadata?.caption;
  const sizeLabel = formatBytes(artifact.metadata?.sizeBytes);
  const downloadUrl = `/api/sessions/${sessionId}/files/${artifact.id}`;

  return (
    <a
      href={downloadUrl}
      download={filename}
      className="flex items-start gap-3 border border-border-muted bg-background p-3 text-sm transition hover:border-border"
    >
      <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center border border-border-muted bg-muted text-muted-foreground">
        <FileIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{filename}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {[caption, sizeLabel].filter(Boolean).join(" · ") || "Download artifact"}
        </span>
      </span>
    </a>
  );
}
