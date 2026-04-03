"use client";

import { getSafeExternalUrl } from "@/lib/urls";
import { GlobeIcon } from "@/components/ui/icons";
import type { SandboxStatus } from "@open-inspect/shared";
import { ACTIVE_SANDBOX_STATUSES } from "./index";

interface TunnelUrlsSectionProps {
  urls: Record<string, string>;
  sandboxStatus: SandboxStatus;
}

export function TunnelUrlsSection({ urls, sandboxStatus }: TunnelUrlsSectionProps) {
  const isActive = ACTIVE_SANDBOX_STATUSES.has(sandboxStatus);
  const entries = Object.entries(urls);

  return (
    <div className="space-y-1.5">
      {entries.map(([port, url]) => {
        const safeUrl = getSafeExternalUrl(url);
        return (
          <div key={port} className="flex items-center gap-2 text-sm">
            <GlobeIcon
              className={`w-4 h-4 shrink-0 ${isActive && safeUrl ? "text-muted-foreground" : "text-muted-foreground/50"}`}
            />
            {isActive && safeUrl ? (
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline truncate"
              >
                Port {port}
              </a>
            ) : (
              <span className="text-muted-foreground truncate">Port {port}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
