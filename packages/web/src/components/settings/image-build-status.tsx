"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/time";

/** Presentation-ready view of one prebuilt image's latest build. */
export interface ImageBuildStatusView {
  status: "building" | "ready" | "failed";
  createdAt: number;
  /** Extra line under a ready status, e.g. "abc1234 · 45s". */
  readyDetails?: string;
  errorMessage?: string | null;
}

/**
 * Shared build-status rendering for prebuilt images (repo images and
 * environment images): status dot, relative time, ready details, and the
 * failed-error tooltip. Callers map their row shape to ImageBuildStatusView.
 * Must render inside a TooltipProvider.
 */
export function ImageBuildStatus({
  image,
  isEnabled,
}: {
  image: ImageBuildStatusView | undefined;
  isEnabled: boolean;
}) {
  if (!isEnabled) {
    return <span className="text-xs text-muted-foreground">Disabled</span>;
  }

  if (!image) {
    return <span className="text-xs text-muted-foreground">No image</span>;
  }

  if (image.status === "ready") {
    return (
      <div className="text-right">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-success flex-shrink-0" />
          <span className="text-xs text-foreground">
            Ready {formatRelativeTime(image.createdAt)}
          </span>
        </div>
        {image.readyDetails && (
          <span className="text-xs text-muted-foreground">{image.readyDetails}</span>
        )}
      </div>
    );
  }

  if (image.status === "building") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-warning animate-pulse flex-shrink-0" />
        <span className="text-xs text-foreground">
          Building... {formatRelativeTime(image.createdAt)}
        </span>
      </div>
    );
  }

  if (image.status === "failed") {
    return (
      <div className="text-right">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-destructive flex-shrink-0" />
          <span className="text-xs text-foreground">Failed</span>
        </div>
        {image.errorMessage && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground truncate max-w-[200px] block cursor-help">
                {image.errorMessage}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-md overflow-visible whitespace-pre-wrap break-words">
              {image.errorMessage}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }

  return null;
}

/** Formats the ready-details line shared by both image families. */
export function formatReadyDetails(
  buildSha: string | null | undefined,
  buildDurationSeconds: number | null | undefined
): string {
  const sha = buildSha ? buildSha.slice(0, 7) : "";
  const duration = buildDurationSeconds ? `${Math.round(buildDurationSeconds)}s` : "";
  return [sha, duration].filter(Boolean).join(" · ");
}
