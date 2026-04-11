"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Artifact } from "@/types/session";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getSafeExternalUrl } from "@/lib/urls";

interface ActionBarProps {
  sessionId: string;
  sessionStatus: string;
  artifacts: Artifact[];
  onArchive?: () => void | Promise<void>;
  onUnarchive?: () => void | Promise<void>;
}

export function ActionBar({
  sessionId,
  sessionStatus,
  artifacts,
  onArchive,
  onUnarchive,
}: ActionBarProps) {
  const [isArchiving, setIsArchiving] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);

  const prArtifact = artifacts.find((a) => a.type === "pr");
  const previewArtifact = artifacts.find((a) => a.type === "preview");
  const screenshotCount = artifacts.filter((artifact) => artifact.type === "screenshot").length;
  const previewUrl = getSafeExternalUrl(previewArtifact?.url);
  const prUrl = getSafeExternalUrl(prArtifact?.url);

  const isArchived = sessionStatus === "archived";

  const handleArchiveToggle = async () => {
    if (!isArchived) {
      setShowArchiveDialog(true);
      return;
    }

    setIsArchiving(true);
    try {
      if (onUnarchive) await onUnarchive();
    } finally {
      setIsArchiving(false);
    }
  };

  const handleConfirmArchive = async () => {
    setShowArchiveDialog(false);
    setIsArchiving(true);
    try {
      if (onArchive) await onArchive();
    } finally {
      setIsArchiving(false);
    }
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/session/${sessionId}`;
    await navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
  };

  return (
    <>
      <div className="flex flex-wrap items-stretch gap-2">
        {/* View Preview */}
        {previewUrl && (
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <a href={previewUrl} target="_blank" rel="noopener noreferrer">
              <GlobeIcon className="w-4 h-4" />
              <span>View preview</span>
              {previewArtifact?.metadata?.previewStatus === "outdated" && (
                <span className="text-xs text-yellow-600 dark:text-yellow-400">(outdated)</span>
              )}
            </a>
          </Button>
        )}

        {/* View PR */}
        {prUrl && (
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
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
          onClick={handleArchiveToggle}
          disabled={isArchiving}
          className="gap-1.5"
        >
          <ArchiveIcon className="w-4 h-4" />
          <span>{isArchived ? "Unarchive" : "Archive"}</span>
        </Button>

        {screenshotCount > 0 && (
          <div className="inline-flex items-center rounded-md border border-border-muted px-3 text-sm text-muted-foreground">
            Screenshots ({screenshotCount})
          </div>
        )}

        {/* More menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="!px-2">
              <MoreIcon className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuItem onClick={handleCopyLink}>
              <LinkIcon className="w-4 h-4" />
              Copy link
            </DropdownMenuItem>
            {prUrl && (
              <DropdownMenuItem asChild>
                <a href={prUrl} target="_blank" rel="noopener noreferrer">
                  <GitHubIcon className="w-4 h-4" />
                  View in GitHub
                </a>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive session</AlertDialogTitle>
            <AlertDialogDescription>
              Archive this session? You can restore archived sessions from Settings &gt; Data
              Controls.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmArchive}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
