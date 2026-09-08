"use client";

import type { ReactNode } from "react";
import { ChevronRightIcon } from "@/components/ui/icons";

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 1) return "less than a second";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 ? `${hours}h` : null, minutes > 0 ? `${minutes}m` : null, `${seconds}s`]
    .filter(Boolean)
    .join(" ");
}

export function SessionWorkGroup({
  durationMs,
  isExpanded,
  onToggle,
  children,
}: {
  durationMs: number;
  isExpanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const label = `Worked for ${formatDuration(durationMs)}`;

  return (
    <div className="border-b border-border-muted py-1">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span>{label}</span>
        <ChevronRightIcon
          className={`h-4 w-4 shrink-0 text-secondary-foreground transition-transform duration-200 ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
      </button>
      {isExpanded && <div className="space-y-2 pb-2 pt-1">{children}</div>}
    </div>
  );
}
