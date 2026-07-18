"use client";

import { useSessionDiffRetry } from "@/hooks/use-session-diffs";
import { cn } from "@/lib/utils";

/**
 * Diff refresh failure notice with a retry action. One render tree for both
 * contexts: "banner" lays out as a full-width strip for the changes panel,
 * "inline" as a stacked block inside a sidebar section — the variant only
 * selects layout classes.
 */
export function DiffRetryNotice({
  sessionId,
  message,
  variant,
}: {
  sessionId: string;
  message: string;
  variant: "banner" | "inline";
}) {
  const { retry, isRetrying, retryError } = useSessionDiffRetry(sessionId);
  const banner = variant === "banner";

  return (
    <>
      <div
        className={
          banner
            ? "flex items-center gap-2 border-b border-destructive-border bg-destructive-muted px-3 py-2"
            : "space-y-1.5"
        }
      >
        <p className={cn("text-xs text-destructive", banner && "min-w-0 flex-1 truncate")}>
          {message}
        </p>
        <button
          type="button"
          onClick={() => void retry()}
          disabled={isRetrying}
          className={cn(
            "text-xs font-medium underline underline-offset-2 disabled:opacity-50",
            !banner && "text-accent"
          )}
        >
          {isRetrying ? "Retrying…" : "Retry"}
        </button>
      </div>
      {retryError && (
        <p
          role="alert"
          className={cn(
            "text-xs text-destructive",
            banner ? "border-b border-destructive-border px-3 py-2" : "mt-1.5"
          )}
        >
          {retryError}
        </p>
      )}
    </>
  );
}
