"use client";

import { useMemo, useState } from "react";
import { TerminalIcon, LinkIcon } from "@/components/ui/icons";
import { buildAuthenticatedUrl } from "@/lib/urls";

interface TerminalPanelProps {
  url: string;
  token: string;
  onClose: () => void;
}

export function TerminalPanel({ url, token, onClose }: TerminalPanelProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const authenticatedUrl = useMemo(() => buildAuthenticatedUrl(url, token), [url, token]);

  if (!authenticatedUrl) return null;

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Terminal toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-muted bg-muted/50">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <TerminalIcon className="h-3.5 w-3.5" />
          <span className="font-medium">Terminal</span>
        </div>
        <div className="flex items-center gap-1">
          <a
            href={authenticatedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 text-muted-foreground hover:text-foreground transition"
            title="Open in new tab"
          >
            <LinkIcon className="h-3.5 w-3.5" />
          </a>
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground transition"
            title="Close terminal"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* iframe */}
      <div className="flex-1 relative">
        {isLoading && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <span className="text-sm text-muted-foreground">Connecting to terminal...</span>
          </div>
        )}
        {hasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background gap-2">
            <span className="text-sm text-muted-foreground">
              Terminal session expired or failed to load.
            </span>
            <span className="text-xs text-muted-foreground">Refresh the page to reconnect.</span>
          </div>
        )}
        <iframe
          src={authenticatedUrl}
          className="w-full h-full border-0"
          allow="clipboard-read; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-popups"
          onLoad={() => setIsLoading(false)}
          onError={() => setHasError(true)}
        />
      </div>
    </div>
  );
}
