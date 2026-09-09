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
  ChevronUpIcon,
} from "@/components/ui/icons";
import { Badge } from "@/components/ui/badge";
import { prBadgeVariant } from "@/components/ui/badge-variants";
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
  capabilities,
}: ActionBarProps) {
  const { previewArtifact, previewUrl, prLinks, mediaCount } = resolveSessionActions(
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

        {/* View PR — a direct link for one PR, a picker for several */}
        {prLinks.length === 1 && (
          <Button variant="outline" size="sm" className="hidden gap-1.5 md:inline-flex" asChild>
            <a href={prLinks[0].url} target="_blank" rel="noopener noreferrer">
              <GitPrIcon className="w-4 h-4" />
              <span>View PR</span>
            </a>
          </Button>
        )}
        {prLinks.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="hidden gap-1.5 md:inline-flex">
                <GitPrIcon className="w-4 h-4" />
                <span>View PRs ({prLinks.length})</span>
                <ChevronUpIcon className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              {prLinks.map((link) => (
                <DropdownMenuItem key={link.id} asChild>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    <GitPrIcon className="w-4 h-4" />
                    <span className="max-w-[16rem] truncate">{link.label}</span>
                    {link.prState && (
                      <Badge variant={prBadgeVariant(link.prState)} className="capitalize">
                        {link.prState}
                      </Badge>
                    )}
                  </a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Archive/Unarchive */}
        {capabilities.lifecycle && (
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
        )}

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
            {prLinks.length === 1 && (
              <DropdownMenuItem className="hidden md:flex" asChild>
                <a href={prLinks[0].url} target="_blank" rel="noopener noreferrer">
                  <GitHubIcon className="w-4 h-4" />
                  View in GitHub
                </a>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {capabilities.lifecycle && (
        <ArchiveSessionDialog
          open={controls.showArchiveDialog}
          onOpenChange={controls.setShowArchiveDialog}
          onConfirm={controls.handleConfirmArchive}
        />
      )}
    </>
  );
}
