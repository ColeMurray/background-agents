"use client";

import type { Artifact } from "@/types/session";
import { ScreenshotArtifactCard } from "@/components/screenshot-artifact-card";

interface MediaSectionProps {
  sessionId: string;
  mediaArtifacts: Artifact[];
  onOpenMedia: (artifactId: string) => void;
}

export function MediaSection({ sessionId, mediaArtifacts, onOpenMedia }: MediaSectionProps) {
  if (mediaArtifacts.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-3">
      {mediaArtifacts.map((artifact) => (
        <ScreenshotArtifactCard
          key={artifact.id}
          sessionId={sessionId}
          artifactId={artifact.id}
          artifactType={artifact.type}
          metadata={artifact.metadata}
          onOpen={onOpenMedia}
          compact={true}
        />
      ))}
    </div>
  );
}
