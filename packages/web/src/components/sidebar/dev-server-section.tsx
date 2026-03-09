"use client";

import { useState } from "react";
import { copyToClipboard } from "@/lib/format";
import { GlobeIcon, CopyIcon, CheckIcon } from "@/components/ui/icons";
import type { SandboxStatus } from "@open-inspect/shared";

interface DevServerSectionProps {
  url: string;
  sandboxStatus: SandboxStatus;
}

const ACTIVE_STATUSES: Set<SandboxStatus> = new Set(["ready", "running", "snapshotting"]);
const STARTING_STATUSES: Set<SandboxStatus> = new Set([
  "pending",
  "spawning",
  "connecting",
  "warming",
  "syncing",
]);

export function DevServerSection({ url, sandboxStatus }: DevServerSectionProps) {
  const [copied, setCopied] = useState(false);
  const isActive = ACTIVE_STATUSES.has(sandboxStatus);
  const isStarting = STARTING_STATUSES.has(sandboxStatus);

  const handleCopyUrl = async () => {
    const success = await copyToClipboard(url);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <GlobeIcon
        className={`w-4 h-4 shrink-0 ${isActive ? "text-muted-foreground" : "text-muted-foreground/50"}`}
      />
      {isActive ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline truncate"
        >
          Open Preview
        </a>
      ) : (
        <span className="text-muted-foreground truncate">
          {isStarting ? "Preview starting\u2026" : "Preview unavailable"}
        </span>
      )}
      {isActive && (
        <button
          onClick={handleCopyUrl}
          className="p-1 hover:bg-muted transition-colors shrink-0"
          title={copied ? "Copied!" : "Copy URL"}
        >
          {copied ? (
            <CheckIcon className="w-3.5 h-3.5 text-success" />
          ) : (
            <CopyIcon className="w-3.5 h-3.5 text-secondary-foreground" />
          )}
        </button>
      )}
    </div>
  );
}
