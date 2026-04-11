"use client";

import type { Artifact } from "@/types/session";
import { ScreenshotArtifactCard } from "@/components/screenshot-artifact-card";

interface MediaSectionProps {
  sessionId: string;
  screenshots: Artifact[];
  onOpenMedia: (artifactId: string) => void;
}

export function MediaSection({ sessionId, screenshots, onOpenMedia }: MediaSectionProps) {
  if (screenshots.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-3">
      {screenshots.map((artifact) => (
        <ScreenshotArtifactCard
          key={artifact.id}
          sessionId={sessionId}
          artifactId={artifact.id}
          metadata={artifact.metadata}
          onOpen={onOpenMedia}
          compact={true}
        />
      ))}
    </div>
  );
}
