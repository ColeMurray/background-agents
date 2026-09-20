import type { SandboxPreservationState } from "@open-inspect/shared/types/sandbox-preservation";
import { cn } from "@/lib/utils";

const PHASE_MESSAGES: Record<Exclude<SandboxPreservationState["phase"], "running">, string> = {
  draining: "Stopping the prompt to save your sandbox state.",
  prepared: "Prompt stopped. Preparing final sandbox state.",
  capturing: "Saving final sandbox state.",
  retiring: "State saved. Confirming sandbox shutdown.",
  saved: "Sandbox saved and stopped.",
  restoring: "Restoring the saved sandbox state.",
  failed: "Final sandbox save failed. Changes since the last verified save may be missing.",
  unknown: "Final sandbox save could not be confirmed. Changes may be missing.",
};

interface SandboxShutdownBannerProps {
  preservation: SandboxPreservationState | null | undefined;
  onRecover?: (action: "retry" | "restore_saved") => void;
}

export function SandboxShutdownBanner({ preservation, onRecover }: SandboxShutdownBannerProps) {
  if (!preservation || preservation.phase === "running") return null;

  const isError = preservation.phase === "failed" || preservation.phase === "unknown";
  const isContinuationPaused =
    preservation.phase === "saved" && preservation.continuationPaused === true;
  const canResumeQueuedWork = isContinuationPaused && preservation.hasRecoveryPoint === true;
  const detail = preservation.error ?? preservation.reason;

  return (
    <div
      role={isError ? "alert" : "status"}
      className={cn(
        "border-b px-4 py-2.5 text-sm",
        isError
          ? "border-destructive-border bg-destructive-muted text-destructive"
          : "border-border-muted bg-muted text-foreground"
      )}
    >
      <span className="font-medium">{PHASE_MESSAGES[preservation.phase]}</span>
      {isContinuationPaused && (
        <span className="ml-2">
          The previous prompt was interrupted and will not replay automatically. Partial work was
          saved. Queued work will wait until you resume.
        </span>
      )}
      {detail && <span className="ml-2">{detail}</span>}
      {preservation.phase === "failed" && onRecover && (
        <button type="button" className="ml-3 underline" onClick={() => onRecover("retry")}>
          Retry shutdown
        </button>
      )}
      {isError && preservation.hasRecoveryPoint && onRecover && (
        <button
          type="button"
          className="ml-3 underline"
          onClick={() => {
            if (
              window.confirm(
                "Restore the last saved sandbox state? Changes since that save may be lost."
              )
            ) {
              onRecover("restore_saved");
            }
          }}
        >
          Restore saved state
        </button>
      )}
      {canResumeQueuedWork && onRecover && (
        <button type="button" className="ml-3 underline" onClick={() => onRecover("restore_saved")}>
          Resume queued work
        </button>
      )}
    </div>
  );
}
