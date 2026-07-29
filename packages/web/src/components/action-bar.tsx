"use client";

import { ArchiveSessionDialog } from "@/components/archive-session-dialog";
import {
  resolveSessionActions,
  useSessionActionControls,
  type SessionActionProps,
} from "@/components/session-actions";
import {
  GlobeIcon,
  GitPrIcon,
  ArchiveIcon,
  MoreIcon,
  LinkIcon,
  GitHubIcon,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ActionBarProps = SessionActionProps;

export function ActionBar({
  sessionId,
  sessionStatus,
  artifacts,
  primaryRepo,
  onArchive,
  onUnarchive,
}: ActionBarProps) {
  const { previewArtifact, previewUrl, prUrl, mediaCount } = resolveSessionActions(
    artifacts,
    primaryRepo
  );
  const controls = useSessionActionControls({
    sessionId,
    sessionStatus,
    onArchive,
    onUnarchive,
  });

  return (
    <>
      <div className="flex flex-wrap items-stretch gap-2">
        {/* View Preview */}
        {previewUrl && (
          <Button variant="outline" size="sm" className="hidden gap-1.5 md:inline-flex" asChild>
            <a href={previewUrl} target="_blank" rel="noopener noreferrer">
              <GlobeIcon className="w-4 h-4" />
              <span>View preview</span>
              {previewArtifact?.metadata?.previewStatus === "outdated" && (
                <span className="text-xs text-warning">(outdated)</span>
              )}
            </a>
          </Button>
        )}

        {/* View PR */}
        {prUrl && (
          <Button variant="outline" size="sm" className="hidden gap-1.5 md:inline-flex" asChild>
            <a href={prUrl} target="_blank" rel="noopener noreferrer">
              <GitPrIcon className="w-4 h-4" />
              <span>View PR</span>
            </a>
          </Button>
        )}

        {/* Archive/Unarchive */}
        <Button
          variant="outline"
          size="sm"
          onClick={controls.handleArchiveToggle}
          disabled={controls.isArchiving}
          className="hidden gap-1.5 md:inline-flex"
        >
          <ArchiveIcon className="w-4 h-4" />
          <span>{controls.isArchived ? "Unarchive" : "Archive"}</span>
        </Button>

        {mediaCount > 0 && (
          <div className="hidden items-center rounded-md border border-border-muted px-3 text-sm text-muted-foreground md:inline-flex">
            Media ({mediaCount})
          </div>
        )}

        {/* More menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="!px-2" aria-label="More session actions">
              <MoreIcon className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuItem onClick={controls.handleCopyLink}>
              <LinkIcon className="w-4 h-4" />
              Copy link
            </DropdownMenuItem>
            {prUrl && (
              <DropdownMenuItem className="hidden md:flex" asChild>
                <a href={prUrl} target="_blank" rel="noopener noreferrer">
                  <GitHubIcon className="w-4 h-4" />
                  View in GitHub
                </a>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ArchiveSessionDialog
        open={controls.showArchiveDialog}
        onOpenChange={controls.setShowArchiveDialog}
        onConfirm={controls.handleConfirmArchive}
      />
    </>
  );
}
