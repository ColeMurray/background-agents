"use client";

import { useState } from "react";
import type { Artifact } from "@/types/session";
import { buildSessionMediaUrl } from "@/lib/media";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { XIcon } from "@/components/ui/icons";

interface MediaLightboxProps {
  sessionId: string;
  artifact: Artifact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MediaLightbox({ sessionId, artifact, open, onOpenChange }: MediaLightboxProps) {
  const isVideo = artifact?.type === "video";
  const caption = artifact?.metadata?.caption || (isVideo ? "Video recording" : "Screenshot");
  const mediaUrl = artifact ? buildSessionMediaUrl(sessionId, artifact.id) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-[min(96vw,1100px)] grid-rows-[auto_auto_minmax(0,1fr)] gap-4 overflow-hidden border-border-muted bg-background p-4">
        <DialogClose
          className="absolute right-3 top-3 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Close media viewer"
        >
          <XIcon className="h-5 w-5" />
        </DialogClose>
        <DialogTitle className="line-clamp-2 pr-8">{caption}</DialogTitle>
        <DialogDescription className="truncate pr-8">
          {artifact?.metadata?.sourceUrl ||
            (isVideo ? "Session video recording" : "Session screenshot")}
        </DialogDescription>

        <MediaPreview
          key={`${open}:${mediaUrl ?? "empty"}`}
          artifact={artifact}
          caption={caption}
          isVideo={isVideo}
          mediaUrl={mediaUrl}
        />
      </DialogContent>
    </Dialog>
  );
}

function MediaPreview({
  artifact,
  caption,
  isVideo,
  mediaUrl,
}: {
  artifact: Artifact | null;
  caption: string;
  isVideo: boolean;
  mediaUrl: string | null;
}) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  return (
    <div className="min-h-0 overflow-auto bg-muted">
      {!artifact ? (
        <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
          No media selected
        </div>
      ) : (
        <>
          {!hasError && mediaUrl && isVideo ? (
            <video
              src={mediaUrl}
              aria-label={`${caption} video`}
              className={isLoaded ? "mx-auto h-auto max-h-full max-w-full" : "invisible"}
              controls
              preload="metadata"
              onLoadedMetadata={() => setIsLoaded(true)}
              onError={() => {
                setHasError(true);
                setIsLoaded(false);
              }}
            />
          ) : !hasError && mediaUrl ? (
            <img
              src={mediaUrl}
              alt={caption}
              className={isLoaded ? "mx-auto h-auto max-w-full object-contain" : "invisible"}
              onLoad={() => setIsLoaded(true)}
              onError={() => {
                setHasError(true);
                setIsLoaded(false);
              }}
            />
          ) : null}
          {isVideo && !isLoaded && (
            <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
              {hasError ? "Preview unavailable" : "Loading video..."}
            </div>
          )}
          {!isVideo && !isLoaded && (
            <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
              {hasError ? "Preview unavailable" : "Loading screenshot..."}
            </div>
          )}
        </>
      )}
    </div>
  );
}
