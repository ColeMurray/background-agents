"use client";

import { useEffect, useState } from "react";
import type { Artifact } from "@/types/session";
import { buildSessionMediaUrl } from "@/lib/media";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface MediaLightboxProps {
  sessionId: string;
  artifact: Artifact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MediaLightbox({ sessionId, artifact, open, onOpenChange }: MediaLightboxProps) {
  const caption = artifact?.metadata?.caption || "Screenshot";
  const mediaUrl = artifact ? buildSessionMediaUrl(sessionId, artifact.id) : null;
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setIsLoaded(false);
    setHasError(false);
  }, [mediaUrl, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(96vw,1100px)] gap-4 border-border-muted bg-background p-4">
        <DialogTitle>{caption}</DialogTitle>
        <DialogDescription>
          {artifact?.metadata?.sourceUrl || "Session screenshot"}
        </DialogDescription>

        <div className="max-h-[80vh] overflow-auto bg-muted">
          {!artifact ? (
            <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
              No screenshot selected
            </div>
          ) : (
            <>
              {!hasError && mediaUrl && (
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
              )}
              {!isLoaded && (
                <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
                  {hasError ? "Preview unavailable" : "Loading screenshot..."}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
