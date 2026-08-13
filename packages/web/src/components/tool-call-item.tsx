"use client";

import type { SandboxEvent } from "@/types/session";
import { formatSessionEventTime } from "@/lib/time";
import { formatToolCall } from "@/lib/tool-formatters";
import { SlackNotifyEvent } from "./slack-notify-event";
import { TimelineRowContent } from "./timeline-row-content";
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
  event: Extract<SandboxEvent, { type: "tool_call" }>;
  isExpanded: boolean;
  onToggle: () => void;
  showTime?: boolean;
}

function ToolIcon({ name }: { name: string | null }) {
  if (!name) return null;

  const iconClass = "mt-[3px] h-3.5 w-3.5 shrink-0 text-secondary-foreground";

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

function ToolCallDetails({ event }: { event: ToolCallItemProps["event"] }) {
  const formatted = formatToolCall(event);
  const isApplyPatch = event.tool?.toLowerCase() === "apply_patch";
  const { args, output } = formatted.getDetails();
  const patchText = isApplyPatch && typeof args?.patchText === "string" ? args.patchText : null;
  const nonPatchArgs =
    isApplyPatch && args
      ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "patchText"))
      : args;
  const hasNonPatchArgs = !!nonPatchArgs && Object.keys(nonPatchArgs).length > 0;

  return (
    <div className="min-w-0 max-w-full overflow-hidden border border-border-muted bg-card p-3 text-xs">
      {hasNonPatchArgs && (
        <div className="mb-2 min-w-0 max-w-full">
          <div className="text-muted-foreground mb-1 font-medium">Arguments:</div>
          <pre className="w-full max-w-full overflow-x-auto whitespace-pre text-foreground">
            {JSON.stringify(nonPatchArgs, null, 2)}
          </pre>
        </div>
      )}
      {patchText && (
        <div className="mb-2 min-w-0 max-w-full">
          <div className="text-muted-foreground mb-1 font-medium">Patch:</div>
          <pre className="max-h-64 w-full max-w-full overflow-x-auto whitespace-pre text-foreground">
            {patchText}
          </pre>
        </div>
      )}
      {output && (
        <div className="min-w-0 max-w-full">
          <div className="text-muted-foreground mb-1 font-medium">Output:</div>
          <pre className="max-h-48 w-full max-w-full overflow-x-auto whitespace-pre text-foreground">
            {output}
          </pre>
        </div>
      )}
      {!hasNonPatchArgs && !patchText && !output && (
        <span className="text-secondary-foreground">No details available</span>
      )}
    </div>
  );
}

export function ToolCallItem({ event, isExpanded, onToggle, showTime = true }: ToolCallItemProps) {
  if (event.tool === "slack-notify") {
    return (
      <SlackNotifyEvent
        event={event}
        isExpanded={isExpanded}
        onToggle={onToggle}
        showTime={showTime}
      />
    );
  }

  const formatted = formatToolCall(event);
  const time = formatSessionEventTime(event.timestamp);

  return (
    <div className="min-w-0 max-w-full py-0.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-start gap-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRightIcon
          className={`mt-[3px] h-3.5 w-3.5 shrink-0 text-secondary-foreground transition-transform duration-200 ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
        <ToolIcon name={formatted.icon} />
        <TimelineRowContent time={showTime ? time : undefined}>
          <span className="block truncate">
            {formatted.toolName} {formatted.summary}
          </span>
        </TimelineRowContent>
      </button>

      {isExpanded && (
        <div className="mt-2 min-w-0 w-full max-w-full sm:ml-5 sm:w-[calc(100%_-_1.25rem)]">
          <ToolCallDetails event={event} />
        </div>
      )}
    </div>
  );
}
