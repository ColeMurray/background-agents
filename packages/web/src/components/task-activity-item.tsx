"use client";

import { useState, type ReactNode } from "react";
import { formatSessionEventTime } from "@/lib/time";
import { formatToolCall } from "@/lib/tool-formatters";
import type { ToolCallEvent } from "@/lib/timeline-items";
import { BoxIcon, ChevronRightIcon } from "@/components/ui/icons";
import { TimelineRowContent } from "./timeline-row-content";

function stringArg(event: ToolCallEvent, key: string): string | null {
  const value = event.args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanTaskResult(output: string | undefined): string | null {
  if (!output?.trim()) return null;

  const trimmed = output.trim();
  const envelope = trimmed.match(
    /^<task(?:\s[^>]*)?>\s*<(task_result|task_error)>\s*([\s\S]*?)\s*<\/\1>\s*<\/task>$/
  );
  return envelope ? envelope[2].trim() : output;
}

function TaskDisclosure({ label, content }: { label: string; content: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border border-border-muted bg-card overflow-hidden">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-left text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRightIcon
          className={`w-3.5 h-3.5 flex-shrink-0 text-secondary-foreground transition-transform duration-200 ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
        {label}
      </button>
      {isExpanded && (
        <pre className="max-h-64 whitespace-pre-wrap border-t border-border-muted px-3 py-2 text-xs text-foreground [overflow-wrap:anywhere]">
          {content}
        </pre>
      )}
    </div>
  );
}

export function TaskActivityItem({
  event,
  hasActivity,
  children,
}: {
  event: ToolCallEvent;
  hasActivity: boolean;
  children: ReactNode;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const formatted = formatToolCall(event);
  const prompt = stringArg(event, "prompt");
  const agent = stringArg(event, "subagent_type");
  const taskId = stringArg(event, "task_id");
  const result = cleanTaskResult(event.output);
  const isRunning = event.status === "running";
  return (
    <div className="py-0.5">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="flex w-full min-w-0 items-start gap-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRightIcon
          className={`mt-[3px] h-3.5 w-3.5 shrink-0 text-secondary-foreground transition-transform duration-200 ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
        <BoxIcon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-secondary-foreground" />
        {isRunning && (
          <span
            aria-hidden="true"
            className="mt-1.5 inline-block h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-accent"
          />
        )}
        <TimelineRowContent time={formatSessionEventTime(event.timestamp)}>
          {formatted.toolName} {formatted.summary}
        </TimelineRowContent>
      </button>
      {isRunning && (
        <span role="status" className="sr-only">
          Task in progress
        </span>
      )}

      {isExpanded && (
        <div className="mt-2 ml-0 space-y-2 sm:ml-5">
          {(agent || taskId) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-secondary-foreground">
              {agent && <span>Agent: {agent}</span>}
              {taskId && <span>Task ID: {taskId}</span>}
            </div>
          )}
          {hasActivity && (
            <div className="space-y-1 border-l-2 border-border py-1 pl-2 sm:pl-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-secondary-foreground mb-1">
                Task activity
              </div>
              {children}
            </div>
          )}
          {prompt && <TaskDisclosure label="Instructions" content={prompt} />}
          {result && <TaskDisclosure label="Result" content={result} />}
        </div>
      )}
    </div>
  );
}
