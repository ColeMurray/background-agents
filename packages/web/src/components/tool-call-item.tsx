"use client";

import type { SandboxEvent } from "@/lib/tool-formatters";
import { formatToolCall } from "@/lib/tool-formatters";

interface ToolCallItemProps {
  event: SandboxEvent;
  isExpanded: boolean;
  onToggle: () => void;
  showTime?: boolean;
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

function ToolIcon({ name }: { name: string | null }) {
  if (!name) return null;

  const iconClass = "w-3.5 h-3.5 text-ash-400";

  switch (name) {
    case "file":
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
    case "pencil":
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
    case "plus":
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      );
    case "terminal":
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
    case "search":
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      );
    case "folder":
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
          />
        </svg>
      );
    case "box":
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          />
        </svg>
      );
    case "globe":
      return (
        <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
          />
        </svg>
      );
    default:
      return null;
  }
}

export function ToolCallItem({ event, isExpanded, onToggle, showTime = true }: ToolCallItemProps) {
  const formatted = formatToolCall(event);
  const time = new Date(event.timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const { args, output } = formatted.getDetails();

  return (
    <div className="py-0.5">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 text-sm text-left text-ash-500 hover:text-ash-900 transition-colors"
      >
        <ChevronIcon rotated={isExpanded} />
        <ToolIcon name={formatted.icon} />
        <span className="truncate">
          {formatted.toolName} {formatted.summary}
        </span>
        {showTime && <span className="text-xs text-ash-400 flex-shrink-0 ml-auto">{time}</span>}
      </button>

      {isExpanded && (
        <div className="mt-2 ml-5 p-3 bg-ash-100 border border-ash-200 rounded-lg text-xs overflow-hidden">
          {args && Object.keys(args).length > 0 && (
            <div className="mb-2">
              <div className="text-ash-500 mb-1 font-medium">Arguments:</div>
              <pre className="overflow-x-auto text-ash-800 whitespace-pre-wrap">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <div className="text-ash-500 mb-1 font-medium">Output:</div>
              <pre className="overflow-x-auto max-h-48 text-ash-800 whitespace-pre-wrap">
                {output}
              </pre>
            </div>
          )}
          {!args && !output && <span className="text-ash-400">No details available</span>}
        </div>
      )}
    </div>
  );
}
