"use client";

import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatReadyDetails, parsePrimaryBuildSha } from "@/lib/image-builds";
import { formatRelativeTime } from "@/lib/time";

/**
 * Shared build-status rendering for prebuilt images (repo images and
 * environment images): status dot, relative time, ready details, and the
 * failed-error tooltip. Takes the feed row itself; superseded rows are
 * filtered at the fetch boundary and would render nothing. Must render
 * inside a TooltipProvider.
 */
export function ImageBuildStatus({
  image,
  isEnabled,
}: {
  image: ImageBuildRecordView | undefined;
  isEnabled: boolean;
}) {
  if (!isEnabled) {
    return <span className="text-xs text-muted-foreground">Disabled</span>;
  }

  if (!image) {
    return <span className="text-xs text-muted-foreground">No image</span>;
  }

  if (image.status === "ready") {
    const readyDetails = formatReadyDetails(
      parsePrimaryBuildSha(image.repositoryShas),
      image.buildDurationSeconds
    );
    return (
      <div className="text-right">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-success flex-shrink-0" />
          <span className="text-xs text-foreground">
            Ready {formatRelativeTime(image.createdAt)}
          </span>
        </div>
        {readyDetails && <span className="text-xs text-muted-foreground">{readyDetails}</span>}
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
