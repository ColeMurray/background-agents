"use client";

import type { Artifact } from "@/types/session";
import { useMediaArtifactUrl } from "@/hooks/use-media-artifact-url";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface MediaLightboxProps {
  sessionId: string;
  artifact: Artifact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MediaLightbox({ sessionId, artifact, open, onOpenChange }: MediaLightboxProps) {
  const { url, isLoading } = useMediaArtifactUrl(sessionId, artifact?.id ?? null);
  const caption = artifact?.metadata?.caption || "Screenshot";

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
          ) : url ? (
            <img src={url} alt={caption} className="mx-auto h-auto max-w-full object-contain" />
          ) : (
            <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
              {isLoading ? "Loading screenshot..." : "Preview unavailable"}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
