"use client";

import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import { MonitorIcon } from "@/components/ui/icons";
import { buildVncUrl } from "@/lib/urls";
import { ACTIVE_SANDBOX_STATUSES, STARTING_SANDBOX_STATUSES } from "./sandbox-statuses";

interface VncSectionProps {
  url: string;
  password: string | null;
  sandboxStatus: SandboxStatus;
}

export function VncSection({ url, password, sandboxStatus }: VncSectionProps) {
  const isActive = ACTIVE_SANDBOX_STATUSES.has(sandboxStatus);
  const isStarting = STARTING_SANDBOX_STATUSES.has(sandboxStatus);
  const vncUrl = buildVncUrl(url, password);

  return (
    <div className="flex items-center gap-2 text-sm">
      <MonitorIcon
        className={`w-4 h-4 shrink-0 ${isActive && vncUrl ? "text-muted-foreground" : "text-muted-foreground/50"}`}
      />
      {isActive && vncUrl ? (
        <a
          href={vncUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline truncate"
        >
          Open Desktop
        </a>
      ) : (
        <span className="text-muted-foreground truncate">
          {isStarting ? "Desktop starting\u2026" : "Desktop unavailable"}
        </span>
      )}
    </div>
  );
}
