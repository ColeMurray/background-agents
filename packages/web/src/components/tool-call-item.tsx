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
} from "@/components/ui/icons";

interface ToolCallItemProps {
  event: SandboxEvent;
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
          {!hasNonPatchArgs && !patchText && !output && (
            <span className="text-secondary-foreground">No details available</span>
          )}
        </div>
      )}
    </div>
  );
}
