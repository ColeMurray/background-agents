"use client";

import { useState } from "react";
import type { Artifact } from "@/types/session";
import {
  GlobeIcon,
  GitPrIcon,
  ArchiveIcon,
  MoreIcon,
  LinkIcon,
  GitHubIcon,
} from "@/components/ui/icons";
import { Button, buttonVariants } from "@/components/ui/button";

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
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const prArtifact = artifacts.find((a) => a.type === "pr");
  const previewArtifact = artifacts.find((a) => a.type === "preview");

  const isArchived = sessionStatus === "archived";

  const handleArchiveToggle = async () => {
    if (!isArchived) {
      const confirmed = window.confirm(
        "Archive this session? You can restore archived sessions from Settings > Data Controls."
      );
      if (!confirmed) return;
    }

    setIsArchiving(true);
    try {
      if (isArchived && onUnarchive) {
        await onUnarchive();
      } else if (!isArchived && onArchive) {
        await onArchive();
      }
    } finally {
      setIsArchiving(false);
    }
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/session/${sessionId}`;
    await navigator.clipboard.writeText(url);
    setIsMenuOpen(false);
  };

  const pillButtonClass = buttonVariants({
    variant: "outline",
    size: "sm",
    className: "flex shrink-0 items-center gap-1.5 whitespace-nowrap",
  });

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {/* View Preview */}
      {previewArtifact?.url && (
        <a
          href={previewArtifact.url}
          target="_blank"
          rel="noopener noreferrer"
          className={pillButtonClass}
        >
          <GlobeIcon className="w-4 h-4" />
          <span>View preview</span>
          {previewArtifact.metadata?.previewStatus === "outdated" && (
            <span className="text-xs text-yellow-600 dark:text-yellow-400">(outdated)</span>
          )}
        </a>
      )}

      {/* View PR */}
      {prArtifact?.url && (
        <a
          href={prArtifact.url}
          target="_blank"
          rel="noopener noreferrer"
          className={pillButtonClass}
        >
          <GitPrIcon className="w-4 h-4" />
          <span>View PR</span>
        </a>
      )}

      {/* Archive/Unarchive */}
      <button
        onClick={handleArchiveToggle}
        disabled={isArchiving}
        className={`${pillButtonClass} disabled:opacity-50`}
      >
        <ArchiveIcon className="w-4 h-4" />
        <span>{isArchived ? "Unarchive" : "Archive"}</span>
      </button>

      {/* More menu */}
      <div className="relative shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="flex shrink-0 items-center justify-center !px-2 h-full"
        >
          <MoreIcon className="w-4 h-4" />
        </Button>

        {isMenuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setIsMenuOpen(false)} />
            <div className="absolute bottom-full right-0 mb-2 w-48 bg-background shadow-lg border border-border py-1 z-20">
              <button
                onClick={handleCopyLink}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted"
              >
                <LinkIcon className="w-4 h-4" />
                Copy link
              </button>
              {prArtifact?.url && (
                <a
                  href={prArtifact.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted"
                  onClick={() => setIsMenuOpen(false)}
                >
                  <GitHubIcon className="w-4 h-4" />
                  View in GitHub
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
