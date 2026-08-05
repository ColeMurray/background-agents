"use client";

import { memo } from "react";
import type { SandboxEvent } from "@/types/session";
import { formatSessionEventTime } from "@/lib/time";
import { formatToolGroup } from "@/lib/tool-formatters";
import { toolCallKey } from "@/lib/timeline-items";
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
  function ToolCallGroup({
    events,
    isExpanded,
    expandedToolCallIds,
    onToggleGroup,
    onToggleTool,
  }: {
    events: Array<Extract<SandboxEvent, { type: "tool_call" }>>;
    isExpanded: boolean;
    expandedToolCallIds: ReadonlySet<string>;
    onToggleGroup: () => void;
    onToggleTool: (event: Extract<SandboxEvent, { type: "tool_call" }>) => void;
  }) {
    const formatted = formatToolGroup(events);
    const firstEvent = events[0];
    const time = formatSessionEventTime(firstEvent.timestamp);

    // For single tool call, render directly without group wrapper
    if (events.length === 1) {
      return (
        <ToolCallItem
          event={firstEvent}
          isExpanded={expandedToolCallIds.has(toolCallKey(firstEvent))}
          onToggle={() => onToggleTool(firstEvent)}
        />
      );
    }

    return (
      <div className="py-1">
        <button
          type="button"
          onClick={onToggleGroup}
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
            {events.map((event) => (
              <ToolCallItem
                key={toolCallKey(event)}
                event={event}
                isExpanded={expandedToolCallIds.has(toolCallKey(event))}
                onToggle={() => onToggleTool(event)}
                showTime={false}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.isExpanded === next.isExpanded &&
    prev.expandedToolCallIds === next.expandedToolCallIds &&
    prev.events.length === next.events.length &&
    prev.events.every((e, i) => e === next.events[i])
);
