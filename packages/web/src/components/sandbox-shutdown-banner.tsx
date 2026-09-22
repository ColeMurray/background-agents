"use client";

import { useState } from "react";
import type {
  SandboxShutdownState,
  ShutdownRecoveryAction,
} from "@open-inspect/shared/types/sandbox-shutdown";
import { cn } from "@/lib/utils";
import type { ShutdownRecoveryResult } from "@/hooks/use-session-socket";

const PHASE_MESSAGES: Record<Exclude<SandboxShutdownState["phase"], "running">, string> = {
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
  shutdown: SandboxShutdownState | null | undefined;
  onRecover?: (action: ShutdownRecoveryAction) => Promise<ShutdownRecoveryResult>;
}

export function SandboxShutdownBanner({ shutdown, onRecover }: SandboxShutdownBannerProps) {
  const [pendingAction, setPendingAction] = useState<ShutdownRecoveryAction | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  if (!shutdown || shutdown.phase === "running") return null;

  const isContinuationPaused = shutdown.phase === "saved" && shutdown.continuationPaused === true;
  // A save that interrupted nothing — an idle timeout or a lifetime expiry — is already
  // reported by the sandbox status and carries no recovery action, so it stays silent.
  if (shutdown.phase === "saved" && !isContinuationPaused) return null;

  const isError = shutdown.phase === "failed" || shutdown.phase === "unknown";
  const recoveryActions = shutdown.availableRecoveryActions ?? [];
  const canRetry = recoveryActions.includes("retry");
  const canRestoreSaved = recoveryActions.includes("restore_saved");
  const canResumeQueuedWork = isContinuationPaused && canRestoreSaved;
  const detail = isError ? (shutdown.error ?? shutdown.reason) : undefined;

  const recover = async (action: ShutdownRecoveryAction) => {
    if (!onRecover || pendingAction) return;
    setPendingAction(action);
    setRecoveryError(null);
    try {
      const result = await onRecover(action);
      if (result.ok) return;
      setRecoveryError(
        result.reason === "rejected"
          ? (result.message ?? "The recovery request was rejected.")
          : "Recovery was not confirmed. Check the current sandbox state before retrying."
      );
    } catch {
      setRecoveryError(
        "Recovery was not confirmed. Check the current sandbox state before retrying."
      );
    } finally {
      setPendingAction(null);
    }
  };

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
      <span className="font-medium">{PHASE_MESSAGES[shutdown.phase]}</span>
      {isContinuationPaused && (
        <span className="ml-2">
          The previous prompt was interrupted and will not replay automatically. Partial work was
          saved. Queued work will wait until you resume.
        </span>
      )}
      {detail && <span className="ml-2">{detail}</span>}
      {shutdown.phase === "failed" && canRetry && onRecover && (
        <button
          type="button"
          className="ml-3 underline disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pendingAction !== null}
          onClick={() => void recover("retry")}
        >
          {pendingAction === "retry" ? "Retrying shutdown…" : "Retry shutdown"}
        </button>
      )}
      {isError && canRestoreSaved && onRecover && (
        <button
          type="button"
          className="ml-3 underline disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pendingAction !== null}
          onClick={() => {
            if (
              window.confirm(
                "Restore the last saved sandbox state? Changes since that save may be lost."
              )
            ) {
              void recover("restore_saved");
            }
          }}
        >
          {pendingAction === "restore_saved" ? "Restoring saved state…" : "Restore saved state"}
        </button>
      )}
      {canResumeQueuedWork && onRecover && (
        <button
          type="button"
          className="ml-3 underline disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pendingAction !== null}
          onClick={() => void recover("restore_saved")}
        >
          {pendingAction === "restore_saved" ? "Resuming queued work…" : "Resume queued work"}
        </button>
      )}
      {recoveryError && (
        <span aria-live="polite" className="ml-3">
          {recoveryError}
        </span>
      )}
    </div>
  );
}
