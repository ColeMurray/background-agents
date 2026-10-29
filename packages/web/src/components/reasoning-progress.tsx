"use client";

import type { ReasoningEvent } from "@open-inspect/shared/types/sandbox-events";
import { ChevronRightIcon } from "@/components/ui/icons";
import { useNow } from "@/hooks/use-now";
import { formatDuration } from "@/lib/format";
import { REASONING_QUIET_AFTER_MS, reasoningDetail, reasoningTitle } from "@/lib/reasoning";

/** Position of a thought within its step, e.g. 26_000 → "+0:26". */
function formatOffset(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.round(offsetMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `+${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `+${minutes}:${seconds}`;
}

function thoughtCount(count: number): string {
  return count === 1 ? "1 thought" : `${count} thoughts`;
}

/**
 * The thinking row while a step reasons: how long it has been thinking, what
 * it last reported, and a note when the reports stop arriving.
 */
export function LiveReasoning({ event }: { event: ReasoningEvent }) {
  const now = useNow(1000);
  const elapsedMs = Math.max(0, now - event.startedAt);
  const quietMs = Math.max(0, now - event.updatedAt);
  const latest = event.summaries.at(-1);

  return (
    <div className="bg-card p-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent animate-pulse" />
        <span className="text-sm text-muted-foreground">
          {elapsedMs >= 1000 ? `Thinking · ${formatDuration(elapsedMs)}` : "Thinking"}
        </span>
        {event.summaryCount > 0 && (
          <span className="ml-auto shrink-0 text-xs text-secondary-foreground">
            {thoughtCount(event.summaryCount)}
          </span>
        )}
      </div>
      {latest && (
        <p
          aria-live="polite"
          className="mt-1 pl-4 text-sm text-foreground [overflow-wrap:anywhere]"
        >
          {reasoningTitle(latest.text)}
        </p>
      )}
      {quietMs >= REASONING_QUIET_AFTER_MS && (
        <p className="mt-1 pl-4 text-xs text-warning">
          No new thoughts for {formatDuration(quietMs)}
        </p>
      )}
    </div>
  );
}

/** A finished step's reasoning: its duration and last thought, expandable to every thought. */
export function ReasoningRow({
  event,
  time,
  isExpanded,
  onToggle,
}: {
  event: ReasoningEvent;
  time: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const latest = event.summaries.at(-1);
  const droppedCount = event.summaryCount - event.summaries.length;

  return (
    <div className="text-sm text-muted-foreground">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-2 py-1 text-left transition-colors hover:text-foreground"
      >
        <span className="shrink-0">
          Thought for {formatDuration(event.updatedAt - event.startedAt)}
        </span>
        {latest && (
          <span className="min-w-0 truncate text-secondary-foreground">
            · {reasoningTitle(latest.text)}
          </span>
        )}
        <ChevronRightIcon
          className={`h-4 w-4 shrink-0 text-secondary-foreground transition-transform duration-200 ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
        <span className="ml-auto shrink-0 text-xs text-secondary-foreground">{time}</span>
      </button>
      {isExpanded && (
        <ol className="mb-1 ml-1 space-y-0.5 border-l border-border-muted pl-3">
          {droppedCount > 0 && (
            <li className="text-xs text-secondary-foreground">
              {thoughtCount(droppedCount)} earlier not kept
            </li>
          )}
          {event.summaries.map((summary, index) => {
            const detail = reasoningDetail(summary.text);
            return (
              <li key={`${summary.at}:${index}`} className="flex min-w-0 gap-2">
                <span className="w-12 shrink-0 text-xs tabular-nums text-secondary-foreground">
                  {formatOffset(summary.at - event.startedAt)}
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {reasoningTitle(summary.text)}
                  {detail && (
                    <span className="block whitespace-pre-line text-muted-foreground">
                      {detail}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
