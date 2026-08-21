import type {
  AutomationExecutionSummary,
  AutomationInvocationStatus,
} from "@open-inspect/shared/types/automations";

const STATUS_PRESENTATION: Record<
  AutomationInvocationStatus,
  { label: string; className: string }
> = {
  starting: { label: "Starting", className: "bg-info/60 motion-safe:animate-pulse" },
  running: { label: "Running", className: "bg-info motion-safe:animate-pulse" },
  completed: { label: "Completed", className: "bg-success" },
  failed: { label: "Failed", className: "bg-destructive" },
  partial_failed: { label: "Partial failure", className: "bg-warning" },
  skipped: { label: "Skipped", className: "bg-muted-foreground/40" },
};

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
        const presentation = STATUS_PRESENTATION[execution.status];
        const occurredAt = new Date(execution.createdAt).toLocaleString();
        return (
          <li
            key={execution.id}
            className={`h-3 w-1 rounded-[1px] ${presentation.className}`}
            title={`${presentation.label} - ${occurredAt}`}
            aria-label={`${presentation.label}, ${occurredAt}`}
          />
        );
      })}
    </ol>
  );
}
