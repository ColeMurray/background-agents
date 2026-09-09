"use client";

import { memo } from "react";
import type { SandboxEvent } from "@/types/session";
import { formatSessionEventTime } from "@/lib/time";
import { formatToolGroup } from "@/lib/tool-formatters";
import { toolCallKey } from "@/lib/timeline-items";
import { ToolCallItem } from "./tool-call-item";
import { TimelineRowContent } from "./timeline-row-content";
import {
  ChevronRightIcon,
  FileIcon,
  PencilIcon,
  TerminalIcon,
  BoltIcon,
} from "@/components/ui/icons";

function ToolIcon({ toolName }: { toolName: string }) {
  const iconClass = "mt-[3px] h-3.5 w-3.5 shrink-0 text-secondary-foreground";

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
          className="-mx-2 flex w-full min-w-0 items-start gap-2 px-2 py-1 text-left text-sm transition-colors hover:bg-muted"
        >
          <ChevronRightIcon
            className={`mt-[3px] h-3.5 w-3.5 shrink-0 text-secondary-foreground transition-transform duration-200 ${
              isExpanded ? "rotate-90" : ""
            }`}
          />
          <ToolIcon toolName={formatted.toolName} />
          <TimelineRowContent time={time}>
            <span className="font-medium text-foreground">{formatted.toolName}</span>{" "}
            <span className="text-muted-foreground">{formatted.summary}</span>
          </TimelineRowContent>
        </button>

        {isExpanded && (
          <div className="ml-2 mt-1 border-l-2 border-border pl-2 sm:ml-4">
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
