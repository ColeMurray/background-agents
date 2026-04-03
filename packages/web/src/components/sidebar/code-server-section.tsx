"use client";

import { useState } from "react";
import { copyToClipboard } from "@/lib/format";
import { getSafeExternalUrl } from "@/lib/urls";
import { TerminalIcon, KeyIcon, CheckIcon } from "@/components/ui/icons";
import type { SandboxStatus } from "@open-inspect/shared";
import { ACTIVE_SANDBOX_STATUSES } from "./index";

interface CodeServerSectionProps {
  url: string;
  password: string | null;
  sandboxStatus: SandboxStatus;
}
const STARTING_STATUSES: Set<SandboxStatus> = new Set([
  "pending",
  "spawning",
  "connecting",
  "warming",
  "syncing",
]);

export function CodeServerSection({ url, password, sandboxStatus }: CodeServerSectionProps) {
  const [copiedPassword, setCopiedPassword] = useState(false);

  const isActive = ACTIVE_SANDBOX_STATUSES.has(sandboxStatus);
  const isStarting = STARTING_STATUSES.has(sandboxStatus);
  const safeUrl = getSafeExternalUrl(url);

  const handleCopyPassword = async () => {
    if (!password) return;
    const success = await copyToClipboard(password);
    if (success) {
      setCopiedPassword(true);
      setTimeout(() => setCopiedPassword(false), 2000);
    }
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <TerminalIcon
        className={`w-4 h-4 shrink-0 ${isActive && safeUrl ? "text-muted-foreground" : "text-muted-foreground/50"}`}
      />
      {isActive && safeUrl ? (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline truncate"
        >
          Open Editor
        </a>
      ) : (
        <span className="text-muted-foreground truncate">
          {isStarting ? "Editor starting\u2026" : "Editor unavailable"}
        </span>
      )}
      {isActive && password && (
        <button
          onClick={handleCopyPassword}
          className="p-1 hover:bg-muted transition-colors shrink-0"
          title={copiedPassword ? "Copied!" : "Copy password"}
        >
          {copiedPassword ? (
            <CheckIcon className="w-3.5 h-3.5 text-success" />
          ) : (
            <KeyIcon className="w-3.5 h-3.5 text-secondary-foreground" />
          )}
        </button>
      )}
    </div>
  );
}
