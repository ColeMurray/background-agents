"use client";

import type { SandboxEvent } from "@/types/session";
import { formatToolCall } from "@/lib/tool-formatters";
import {
  ChevronRightIcon,
  FileIcon,
  PencilIcon,
  PlusIcon,
  TerminalIcon,
  SearchIcon,
  FolderIcon,
  BoxIcon,
  GlobeIcon,
  BoltIcon,
} from "@/components/ui/icons";
import { ScreenshotImage } from "./screenshot-image";

interface ToolCallItemProps {
  event: Extract<SandboxEvent, { type: "tool_call" }>;
  isExpanded: boolean;
  onToggle: () => void;
  showTime?: boolean;
}

function ToolIcon({ name }: { name: string | null }) {
  if (!name) return null;

  const iconClass = "w-3.5 h-3.5 text-secondary-foreground";

  switch (name) {
    case "file":
      return <FileIcon className={iconClass} />;
    case "pencil":
      return <PencilIcon className={iconClass} />;
    case "plus":
      return <PlusIcon className={iconClass} />;
    case "terminal":
      return <TerminalIcon className={iconClass} />;
    case "search":
      return <SearchIcon className={iconClass} />;
    case "folder":
      return <FolderIcon className={iconClass} />;
    case "box":
      return <BoxIcon className={iconClass} />;
    case "globe":
      return <GlobeIcon className={iconClass} />;
    case "bolt":
      return <BoltIcon className={iconClass} />;
    case "camera":
      return (
        <svg
          className={iconClass}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      );
    default:
      return null;
  }
}

export function ToolCallItem({ event, isExpanded, onToggle, showTime = true }: ToolCallItemProps) {
  const formatted = formatToolCall(event);
  const isApplyPatch = event.tool?.toLowerCase() === "apply_patch";
  const time = new Date(event.timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const images = event.images;

  const { args, output } = formatted.getDetails();
  const patchText = isApplyPatch && typeof args?.patchText === "string" ? args.patchText : null;
  const nonPatchArgs =
    isApplyPatch && args
      ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "patchText"))
      : args;
  const hasNonPatchArgs = !!nonPatchArgs && Object.keys(nonPatchArgs).length > 0;

  return (
    <div className="py-0.5">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 text-sm text-left text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRightIcon
          className={`w-3.5 h-3.5 text-secondary-foreground transition-transform duration-200 ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
        <ToolIcon name={formatted.icon} />
        <span className="truncate">
          {formatted.toolName} {formatted.summary}
        </span>
        {showTime && (
          <span className="text-xs text-secondary-foreground flex-shrink-0 ml-auto">{time}</span>
        )}
      </button>

      {isExpanded && (
        <div className="mt-2 ml-5 p-3 bg-card border border-border-muted text-xs overflow-hidden">
          {hasNonPatchArgs && (
            <div className="mb-2">
              <div className="text-muted-foreground mb-1 font-medium">Arguments:</div>
              <pre className="overflow-x-auto text-foreground whitespace-pre-wrap">
                {JSON.stringify(nonPatchArgs, null, 2)}
              </pre>
            </div>
          )}
          {patchText && (
            <div className="mb-2">
              <div className="text-muted-foreground mb-1 font-medium">Patch:</div>
              <pre className="overflow-x-auto max-h-64 text-foreground whitespace-pre-wrap">
                {patchText}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <div className="text-muted-foreground mb-1 font-medium">Output:</div>
              <pre className="overflow-x-auto max-h-48 text-foreground whitespace-pre-wrap">
                {output}
              </pre>
            </div>
          )}
          {!hasNonPatchArgs && !patchText && !output && (!images || images.length === 0) && (
            <span className="text-secondary-foreground">No details available</span>
          )}
        </div>
      )}

      {/* Screenshots always visible, even when collapsed */}
      {images && images.length > 0 && (
        <div className="ml-5">
          {images.map((img, i) => (
            <ScreenshotImage
              key={i}
              base64={img.base64}
              mimeType={img.mimeType}
              filename={img.filename}
            />
          ))}
        </div>
      )}
    </div>
  );
}
