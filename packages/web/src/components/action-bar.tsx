"use client";

import { useState } from "react";
import type { Artifact } from "@/types/session";

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

  // Shared button style for bordered pill buttons
  const pillButtonClass =
    "flex items-center gap-1.5 px-3 py-1.5 text-sm text-foreground border border-border hover:bg-muted transition-colors";

  return (
    <div className="flex items-center gap-2">
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
      <div className="relative">
        <button
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="flex items-center justify-center w-8 h-8 text-muted-foreground hover:text-foreground border border-border hover:bg-muted transition-colors"
        >
          <MoreIcon className="w-4 h-4" />
        </button>

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

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
      />
    </svg>
  );
}

function GitPrIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9"
      />
    </svg>
  );
}

function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
      />
    </svg>
  );
}

function MoreIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
    </svg>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
      />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0012 2z"
      />
    </svg>
  );
}
