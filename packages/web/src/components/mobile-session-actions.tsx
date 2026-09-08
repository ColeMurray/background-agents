"use client";

import type { RefObject } from "react";
import { ArchiveSessionDialog } from "@/components/archive-session-dialog";
import {
  resolveSessionActions,
  useSessionActionControls,
  type SessionActionProps,
} from "@/components/session-actions";
import { Badge } from "@/components/ui/badge";
import { prBadgeVariant } from "@/components/ui/badge-variants";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArchiveIcon,
  FolderIcon,
  GitPrIcon,
  GlobeIcon,
  LinkIcon,
  MoreIcon,
  SidebarIcon,
} from "@/components/ui/icons";

interface MobileSessionActionsProps extends SessionActionProps {
  triggerRef: RefObject<HTMLButtonElement | null>;
  onOpenDetails: () => void;
  onOpenMedia: () => void;
}

export function MobileSessionActions({
  triggerRef,
  onOpenDetails,
  onOpenMedia,
  ...actions
}: MobileSessionActionsProps) {
  const { previewArtifact, previewUrl, prLinks, mediaCount } = resolveSessionActions(
    actions.artifacts,
    actions.primaryRepo
  );
  const controls = useSessionActionControls(actions);

  return (
    <>
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              variant="outline"
              size="sm"
              className="!px-2"
              aria-label="Session actions"
            >
              <MoreIcon className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem onClick={onOpenDetails}>
              <SidebarIcon className="w-4 h-4" />
              Details
            </DropdownMenuItem>
            {previewUrl && (
              <DropdownMenuItem asChild>
                <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                  <GlobeIcon className="w-4 h-4" />
                  View preview
                  {previewArtifact?.metadata?.previewStatus === "outdated" && " (outdated)"}
                </a>
              </DropdownMenuItem>
            )}
            {prLinks.length === 1 && (
              <DropdownMenuItem asChild>
                <a href={prLinks[0].url} target="_blank" rel="noopener noreferrer">
                  <GitPrIcon className="w-4 h-4" />
                  View PR
                </a>
              </DropdownMenuItem>
            )}
            {prLinks.length > 1 &&
              prLinks.map((link) => (
                <DropdownMenuItem key={link.id} asChild>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    <GitPrIcon className="w-4 h-4" />
                    <span className="min-w-0 truncate">{link.label}</span>
                    {link.prState && (
                      <Badge variant={prBadgeVariant(link.prState)} className="capitalize">
                        {link.prState}
                      </Badge>
                    )}
                  </a>
                </DropdownMenuItem>
              ))}
            {mediaCount > 0 && (
              <DropdownMenuItem onClick={onOpenMedia}>
                <FolderIcon className="w-4 h-4" />
                Media ({mediaCount})
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={controls.handleCopyLink}>
              <LinkIcon className="w-4 h-4" />
              Copy link
            </DropdownMenuItem>
            {actions.capabilities.lifecycle && <DropdownMenuSeparator />}
            {actions.capabilities.lifecycle && (
              <DropdownMenuItem
                onClick={controls.handleArchiveToggle}
                disabled={controls.isArchiving}
              >
                <ArchiveIcon className="w-4 h-4" />
                {controls.isArchived ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {actions.capabilities.lifecycle && (
        <ArchiveSessionDialog
          open={controls.showArchiveDialog}
          onOpenChange={controls.setShowArchiveDialog}
          onConfirm={controls.handleConfirmArchive}
        />
      )}
    </>
  );
}
