"use client";

import { useEffect, useState } from "react";
import type { Artifact } from "@/types/session";
import { buildSessionMediaUrl } from "@/lib/media";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "@/components/ui/icons";

interface MediaLightboxProps {
  sessionId: string;
  /** Media artifacts in display order; arrow keys step through this list. */
  artifacts: Artifact[];
  selectedArtifactId: string | null;
  /** Called with the next artifact to show, or null to close the lightbox. */
  onSelectArtifact: (artifactId: string | null) => void;
}

const navButtonClassName =
  "rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

/** Arrow keys inside these elements keep their native behavior (e.g. video seeking). */
function isArrowKeyOwner(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLVideoElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function MediaLightbox({
  sessionId,
  artifacts,
  selectedArtifactId,
  onSelectArtifact,
}: MediaLightboxProps) {
  const open = selectedArtifactId !== null;
  const index = artifacts.findIndex((candidate) => candidate.id === selectedArtifactId);
  const artifact = index >= 0 ? artifacts[index] : null;
  const previousArtifactId = index > 0 ? artifacts[index - 1].id : null;
  const nextArtifactId =
    index >= 0 && index < artifacts.length - 1 ? artifacts[index + 1].id : null;
  const showNavigation = artifact !== null && artifacts.length > 1;

  const isVideo = artifact?.type === "video";
  const caption = artifact?.metadata?.caption || (isVideo ? "Video recording" : "Screenshot");
  const mediaUrl = artifact ? buildSessionMediaUrl(sessionId, artifact.id) : null;

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey || isArrowKeyOwner(event.target)) return;

      const targetId =
        event.key === "ArrowLeft"
          ? previousArtifactId
          : event.key === "ArrowRight"
            ? nextArtifactId
            : null;
      if (!targetId) return;

      event.preventDefault();
      onSelectArtifact(targetId);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, previousArtifactId, nextArtifactId, onSelectArtifact]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onSelectArtifact(null);
      }}
    >
      <DialogContent
        className={`max-h-[calc(100dvh-2rem)] max-w-[min(96vw,1100px)] ${
          showNavigation
            ? "grid-rows-[auto_auto_minmax(0,1fr)_auto]"
            : "grid-rows-[auto_auto_minmax(0,1fr)]"
        } gap-4 overflow-hidden border-border-muted bg-background p-4`}
      >
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

        {showNavigation && (
          <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <button
              type="button"
              className={navButtonClassName}
              aria-label="Previous media"
              disabled={!previousArtifactId}
              onClick={() => previousArtifactId && onSelectArtifact(previousArtifactId)}
            >
              <ChevronLeftIcon className="h-5 w-5" />
            </button>
            <span aria-live="polite">
              {index + 1} of {artifacts.length}
            </span>
            <button
              type="button"
              className={navButtonClassName}
              aria-label="Next media"
              disabled={!nextArtifactId}
              onClick={() => nextArtifactId && onSelectArtifact(nextArtifactId)}
            >
              <ChevronRightIcon className="h-5 w-5" />
            </button>
          </div>
        )}
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
