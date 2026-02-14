"use client";

import { useState } from "react";
import type { SandboxEvent } from "@/lib/tool-formatters";
import { formatToolGroup } from "@/lib/tool-formatters";
import { ToolCallItem } from "./tool-call-item";

interface ToolCallGroupProps {
  events: SandboxEvent[];
  groupId: string;
}

function ChevronIcon({ rotated }: { rotated: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 text-ash-400 transition-transform duration-200 ${
        rotated ? "rotate-90" : ""
      }`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function ToolIcon({ toolName }: { toolName: string }) {
  const iconClass = "w-3.5 h-3.5 text-ash-400";

  switch (toolName) {
    case "Read":
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      );
    case "Edit":
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
          />
        </svg>
      );
    case "Bash":
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
      );
    default:
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
      );
  }
}

export function ToolCallGroup({ events, groupId }: ToolCallGroupProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  const formatted = formatToolGroup(events);
  const firstEvent = events[0];
  const _lastEvent = events[events.length - 1];

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
        className="w-full flex items-center gap-2 text-sm text-left hover:bg-ash-100 rounded-lg px-2 py-1 -mx-2 transition-colors"
      >
        <ChevronIcon rotated={isExpanded} />
        <ToolIcon toolName={formatted.toolName} />
        <span className="font-medium text-ash-900">{formatted.toolName}</span>
        <span className="text-ash-500">{formatted.summary}</span>
        <span className="text-xs text-ash-400 ml-auto flex-shrink-0">{time}</span>
      </button>

      {isExpanded && (
        <div className="ml-4 mt-1 pl-2 border-l-2 border-ash-200">
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
}
