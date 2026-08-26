import type {
  AutomationExecutionSummary,
  AutomationInvocationStatus,
} from "@open-inspect/shared/types/automations";
import {
  AUTOMATION_INVOCATION_STATUS,
  type AutomationInvocationTone,
} from "@/lib/automation-invocation-status";

const TONE_CLASSES: Record<AutomationInvocationTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-info",
  success: "text-success",
  danger: "text-destructive",
  warning: "text-warning",
};

const SHAPE_CLASSES: Record<Exclude<AutomationInvocationStatus, "failed">, string> = {
  starting: "h-2 w-2 rounded-full border border-current motion-safe:animate-pulse",
  running: "h-2 w-2 rounded-full bg-current motion-safe:animate-pulse",
  completed: "h-3 w-1 rounded-[1px] bg-current",
  partial_failed: "h-3 w-1 border border-dashed border-current",
  skipped: "h-px w-2 bg-current",
};

function StatusShape({ status }: { status: AutomationInvocationStatus }) {
  if (status === "failed") {
    return (
      <span className="relative h-2 w-2" aria-hidden="true">
        <span className="absolute left-1 top-0 h-2 w-px rotate-45 bg-current" />
        <span className="absolute left-1 top-0 h-2 w-px -rotate-45 bg-current" />
      </span>
    );
  }

  return <span className={SHAPE_CLASSES[status]} aria-hidden="true" />;
}

export function ExecutionActivity({ executions }: { executions: AutomationExecutionSummary[] }) {
  if (executions.length === 0) {
    return <span className="text-[10px] text-muted-foreground">No runs</span>;
  }

  const chronologicalExecutions = [...executions].reverse();

  return (
    <ol
      className="flex shrink-0 items-center gap-0.5"
      aria-label={`Last ${executions.length} executions, oldest to newest`}
    >
      {chronologicalExecutions.map((execution) => {
        const presentation = AUTOMATION_INVOCATION_STATUS[execution.status];
        const occurredAt = new Date(execution.createdAt).toLocaleString();
        return (
          <li
            key={execution.id}
            className={`flex h-4 w-2 items-center justify-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring ${TONE_CLASSES[presentation.tone]}`}
            title={`${presentation.label} - ${occurredAt}`}
            aria-label={`${presentation.label}, ${occurredAt}`}
            data-status-shape={execution.status}
            tabIndex={0}
          >
            <StatusShape status={execution.status} />
          </li>
        );
      })}
    </ol>
  );
}
