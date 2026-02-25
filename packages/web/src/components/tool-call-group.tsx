"use client";

import { memo, useState } from "react";
import type { SandboxEvent } from "@/types/session";
import { formatToolGroup } from "@/lib/tool-formatters";
import { ToolCallItem } from "./tool-call-item";
import {
  ChevronRightIcon,
  FileIcon,
  PencilIcon,
  TerminalIcon,
  BoltIcon,
} from "@/components/ui/icons";

function ToolIcon({ toolName }: { toolName: string }) {
  const iconClass = "w-3.5 h-3.5 text-secondary-foreground";

  switch (toolName) {
    case "Read":
      return <FileIcon className={iconClass} />;
    case "Edit":
      return <PencilIcon className={iconClass} />;
    case "Apply Patch":
      return <PencilIcon className={iconClass} />;
    case "Bash":
      return <TerminalIcon className={iconClass} />;
    default:
      return <BoltIcon className={iconClass} />;
  }
}

export const ToolCallGroup = memo(
  function ToolCallGroup({ events, groupId }: { events: SandboxEvent[]; groupId: string }) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

    const formatted = formatToolGroup(events);
    const firstEvent = events[0];
    const time = new Date(firstEvent.timestamp * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    const toggleItem = (itemId: string) => {
      setExpandedItems((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(itemId)) {
          newSet.delete(itemId);
        } else {
          newSet.add(itemId);
        }
        return newSet;
      });
    };

    // For single tool call, render directly without group wrapper
    if (events.length === 1) {
      return (
        <ToolCallItem
          event={firstEvent}
          isExpanded={expandedItems.has(`${groupId}-0`)}
          onToggle={() => toggleItem(`${groupId}-0`)}
        />
      );
    }

    return (
      <div className="py-1">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center gap-2 text-sm text-left hover:bg-muted px-2 py-1 -mx-2 transition-colors"
        >
          <ChevronRightIcon
            className={`w-3.5 h-3.5 text-secondary-foreground transition-transform duration-200 ${
              isExpanded ? "rotate-90" : ""
            }`}
          />
          <ToolIcon toolName={formatted.toolName} />
          <span className="font-medium text-foreground">{formatted.toolName}</span>
          <span className="text-muted-foreground">{formatted.summary}</span>
          <span className="text-xs text-secondary-foreground ml-auto flex-shrink-0">{time}</span>
        </button>

        {isExpanded && (
          <div className="ml-4 mt-1 pl-2 border-l-2 border-border">
            {events.map((event, index) => (
              <ToolCallItem
                key={`${groupId}-${index}`}
                event={event}
                isExpanded={expandedItems.has(`${groupId}-${index}`)}
                onToggle={() => toggleItem(`${groupId}-${index}`)}
                showTime={false}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.groupId === next.groupId &&
    prev.events.length === next.events.length &&
    prev.events.every((e, i) => e === next.events[i])
);
