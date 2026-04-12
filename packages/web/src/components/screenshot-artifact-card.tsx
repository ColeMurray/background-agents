"use client";

import { useEffect, useState } from "react";
import type { Artifact } from "@/types/session";
import { buildSessionMediaUrl } from "@/lib/media";
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
  const mediaUrl = buildSessionMediaUrl(sessionId, artifactId);
  const caption = metadata?.caption || "Screenshot";
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setIsLoaded(false);
    setHasError(false);
  }, [mediaUrl]);

  return (
    <div className={cn("overflow-hidden border border-border-muted bg-card", className)}>
      <button
        type="button"
        onClick={() => onOpen(artifactId)}
        className="block w-full text-left"
        aria-label={caption}
      >
        <div className="relative aspect-[16/10] overflow-hidden bg-muted">
          {!hasError && (
            <img
              src={mediaUrl}
              alt={caption}
              className={cn(
                "h-full w-full object-cover transition-transform duration-200 hover:scale-[1.01]",
                !isLoaded && "invisible"
              )}
              loading="lazy"
              onLoad={() => setIsLoaded(true)}
              onError={() => {
                setHasError(true);
                setIsLoaded(false);
              }}
            />
          )}
          {!isLoaded && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {hasError ? "Preview unavailable" : "Loading screenshot..."}
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
