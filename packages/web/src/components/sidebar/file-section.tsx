"use client";

import { FileArtifactCard } from "@/components/file-artifact-card";
import type { Artifact } from "@/types/session";

interface FileSectionProps {
  sessionId: string;
  fileArtifacts: Artifact[];
}

export function FileSection({ sessionId, fileArtifacts }: FileSectionProps) {
  if (fileArtifacts.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-3">
      {fileArtifacts.map((artifact) => (
        <FileArtifactCard key={artifact.id} sessionId={sessionId} artifact={artifact} />
      ))}
    </div>
  );
}
