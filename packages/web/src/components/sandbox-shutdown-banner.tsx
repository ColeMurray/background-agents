"use client";

import { useState } from "react";
import type {
  SandboxShutdownState,
  ShutdownRecoveryAction,
} from "@open-inspect/shared/types/sandbox-shutdown";
import { cn } from "@/lib/utils";
import type { ShutdownRecoveryResult } from "@/hooks/use-session-socket";

const PHASE_MESSAGES: Record<
  Extract<SandboxShutdownState["phase"], "saved" | "failed" | "unknown">,
  string
> = {
  saved: "Sandbox saved and stopped.",
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

  if (!shutdown) return null;

  const { phase } = shutdown;
  const isError = phase === "failed" || phase === "unknown";
  const isContinuationPaused = phase === "saved" && shutdown.continuationPaused === true;
  // Routine stops, saves, and restores are reported by the header's sandbox status, which
  // projects graceful-stop phases onto it. The banner is reserved for failures and for an
  // interrupted sandbox that holds queued work.
  if (!isError && !isContinuationPaused) return null;

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
      <span className="font-medium">{PHASE_MESSAGES[phase]}</span>
      {isContinuationPaused && (
        <span className="ml-2">
          The sandbox was interrupted. Partial state was saved. Queued work will wait until you
          resume; interrupted prompts will not replay automatically.
        </span>
      )}
      {detail && <span className="ml-2">{detail}</span>}
      {phase === "failed" && canRetry && onRecover && (
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
