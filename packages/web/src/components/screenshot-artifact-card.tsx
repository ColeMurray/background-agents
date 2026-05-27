"use client";

import { useEffect, useState } from "react";
import type { Artifact } from "@/types/session";
import { buildSessionMediaUrl } from "@/lib/media";
import { cn } from "@/lib/utils";

interface ScreenshotArtifactCardProps {
  sessionId: string;
  artifactId: string;
  artifactType?: Artifact["type"];
  metadata?: Artifact["metadata"];
  onOpen: (artifactId: string) => void;
  className?: string;
  compact?: boolean;
}

export function ScreenshotArtifactCard({
  sessionId,
  artifactId,
  artifactType = "screenshot",
  metadata,
  onOpen,
  className,
  compact = false,
}: ScreenshotArtifactCardProps) {
  const mediaUrl = buildSessionMediaUrl(sessionId, artifactId);
  const isVideo = artifactType === "video";
  const caption = metadata?.caption || (isVideo ? "Video recording" : "Screenshot");
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
          {!hasError && isVideo ? (
            <video
              src={mediaUrl}
              aria-label={`${caption} video preview`}
              className={cn(
                "h-full w-full object-cover transition-transform duration-200 hover:scale-[1.01]",
                !isLoaded && "invisible"
              )}
              muted
              playsInline
              preload="metadata"
              onLoadedMetadata={() => setIsLoaded(true)}
              onError={() => {
                setHasError(true);
                setIsLoaded(false);
              }}
            />
          ) : !hasError ? (
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
          ) : null}
          {isVideo && !hasError && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm">
                <span className="ml-0.5 h-0 w-0 border-y-[7px] border-l-[11px] border-y-transparent border-l-current" />
              </span>
            </div>
          )}
          {!isLoaded && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {hasError ? "Preview unavailable" : `Loading ${isVideo ? "video" : "screenshot"}...`}
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
