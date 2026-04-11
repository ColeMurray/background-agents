"use client";

import type { Artifact } from "@/types/session";
import { useMediaArtifactUrl } from "@/hooks/use-media-artifact-url";
import { cn } from "@/lib/utils";

interface ScreenshotArtifactCardProps {
  sessionId: string;
  artifactId: string;
  metadata?: Artifact["metadata"];
  onOpen: (artifactId: string) => void;
  className?: string;
  compact?: boolean;
}

export function ScreenshotArtifactCard({
  sessionId,
  artifactId,
  metadata,
  onOpen,
  className,
  compact = false,
}: ScreenshotArtifactCardProps) {
  const { url, isLoading } = useMediaArtifactUrl(sessionId, artifactId);
  const caption = metadata?.caption || "Screenshot";

  return (
    <div className={cn("overflow-hidden border border-border-muted bg-card", className)}>
      <button
        type="button"
        onClick={() => onOpen(artifactId)}
        className="block w-full text-left"
        aria-label={caption}
      >
        <div className="relative aspect-[16/10] overflow-hidden bg-muted">
          {url ? (
            <img
              src={url}
              alt={caption}
              className="h-full w-full object-cover transition-transform duration-200 hover:scale-[1.01]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {isLoading ? "Loading screenshot..." : "Preview unavailable"}
            </div>
          )}
        </div>
      </button>

      <div className={cn("space-y-1 p-3", compact && "p-2")}>
        <p className="line-clamp-2 text-sm text-foreground">{caption}</p>
        {!compact && metadata?.sourceUrl && (
          <p className="truncate text-xs text-muted-foreground">{metadata.sourceUrl}</p>
        )}
      </div>
    </div>
  );
}
