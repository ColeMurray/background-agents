"use client";

import { useState, type ReactNode } from "react";
import { formatSessionEventTime } from "@/lib/time";
import { formatToolCall } from "@/lib/tool-formatters";
import type { ToolCallEvent } from "@/lib/timeline-items";
import { BoxIcon, ChevronRightIcon } from "@/components/ui/icons";
import { ToolCallDetails } from "@/components/tool-call-item";

export function TaskActivityItem({
  event,
  children,
}: {
  event: ToolCallEvent;
  children: ReactNode;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const formatted = formatToolCall(event);

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="w-full flex items-center gap-1.5 text-sm text-left text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRightIcon
          className={`w-3.5 h-3.5 text-secondary-foreground transition-transform duration-200 ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
        <BoxIcon className="w-3.5 h-3.5 text-secondary-foreground" />
        <span className="truncate">
          {formatted.toolName} {formatted.summary}
        </span>
        <span className="text-xs text-secondary-foreground flex-shrink-0 ml-auto">
          {formatSessionEventTime(event.timestamp)}
        </span>
      </button>

      {isExpanded && (
        <div className="mt-2 ml-5 space-y-2">
          <div className="border-l-2 border-border pl-3 py-1 space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-secondary-foreground mb-1">
              Task activity
            </div>
            {children}
          </div>
          <ToolCallDetails event={event} />
        </div>
      )}
    </div>
  );
}
