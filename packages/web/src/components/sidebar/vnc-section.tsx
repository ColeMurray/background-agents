"use client";

import { GlobeIcon } from "@/components/ui/icons";
import type { SandboxStatus } from "@open-inspect/shared";

interface VncSectionProps {
  /** VNC tunnel URL (always available when sandbox has a VNC port tunneled). */
  vncUrl: string;
  /** VNC password (set when VNC processes are running; empty/null when inactive). */
  vncPassword: string | null;
  sandboxStatus: SandboxStatus;
}

const ACTIVE_STATUSES: Set<SandboxStatus> = new Set(["ready", "running", "snapshotting"]);

export function VncSection({ vncUrl, vncPassword, sandboxStatus }: VncSectionProps) {
  const isActive = ACTIVE_STATUSES.has(sandboxStatus);
  const isVncRunning = Boolean(vncPassword);

  // Build the noVNC web client URL with auto-connect params
  const noVncUrl = isVncRunning
    ? `${vncUrl}/vnc.html?password=${encodeURIComponent(vncPassword!)}&autoconnect=true&resize=scale`
    : undefined;

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <div className="flex items-center gap-2">
        <GlobeIcon
          className={`w-4 h-4 shrink-0 ${isActive ? "text-muted-foreground" : "text-muted-foreground/50"}`}
        />
        {isActive ? (
          isVncRunning ? (
            <a
              href={noVncUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline truncate"
            >
              Open Browser View
            </a>
          ) : (
            <span className="text-muted-foreground truncate">Browser starting...</span>
          )
        ) : (
          <span className="text-muted-foreground truncate">Browser unavailable</span>
        )}
      </div>
    </div>
  );
}
