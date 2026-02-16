"use client";

import type { SandboxEvent } from "@/lib/tool-formatters";
import { formatToolCall } from "@/lib/tool-formatters";
import { Button } from "@/components/ui/button";

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

/**
 * Extract a screenshot URL from tool output text.
 * Matches "URL: https://..." pattern from the screenshot tool.
 */
function extractScreenshotUrl(output: string | null): string | null {
  if (!output) return null;
  const match = output.match(/URL:\s*(https?:\/\/\S+)/);
  return match ? match[1] : null;
}

/**
 * Check if this is a browser-related tool (screenshot, browser, preview).
 */
function isBrowserTool(toolName: string): boolean {
  const browserTools = ["screenshot", "browser", "preview"];
  return browserTools.includes(toolName.toLowerCase());
}

export function ToolCallItem({ event, isExpanded, onToggle, showTime = true }: ToolCallItemProps) {
  const formatted = formatToolCall(event);
  const time = new Date(event.timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const { args, output } = formatted.getDetails();

  // check if this is a preview tool that produced a url
  const isPreview = event.tool === "preview" && event.status === "completed";
  const previewUrl = isPreview && output ? extractScreenshotUrl(output) : null;

  return (
    <div className="py-0.5">
      <Button
        variant="ghost"
        size="xs"
        onClick={onToggle}
        className="w-full justify-start gap-1.5 text-ash-500 h-auto px-0"
      >
        <ChevronIcon rotated={isExpanded} />
        {isBrowserTool(event.tool || "") ? (
          <CameraToolIcon />
        ) : (
          <ToolIcon name={formatted.icon} />
        )}
        <span className="truncate">
          {formatted.toolName} {formatted.summary}
        </span>
        {showTime && <span className="text-xs text-ash-400 flex-shrink-0 ml-auto">{time}</span>}
      </Button>

      {/* inline preview link (shown even when collapsed) */}
      {previewUrl && !isExpanded && (
        <div className="mt-1.5 ml-5">
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-rebolt-500 hover:underline"
          >
            <ToolIcon name="globe" />
            {previewUrl}
          </a>
        </div>
      )}

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

function CameraToolIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-ash-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
      />
      <circle cx="12" cy="13" r="3" strokeWidth={2} />
    </svg>
  );
}
