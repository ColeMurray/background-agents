"use client";

import { useSessionDiffRetry } from "@/hooks/use-session-diffs";

/**
 * Diff refresh failure notice with a retry action. The "banner" variant renders
 * a full-width strip for the changes panel; the "inline" variant fits inside a
 * sidebar section.
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
  const retryLabel = isRetrying ? "Retrying…" : "Retry";

  if (variant === "banner") {
    return (
      <>
        <div className="flex items-center gap-2 border-b border-destructive-border bg-destructive-muted px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 truncate">{message}</span>
          <button
            type="button"
            onClick={() => void retry()}
            disabled={isRetrying}
            className="font-medium underline underline-offset-2"
          >
            {retryLabel}
          </button>
        </div>
        {retryError && (
          <p
            role="alert"
            className="border-b border-destructive-border px-3 py-2 text-xs text-destructive"
          >
            {retryError}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <div className="space-y-1.5">
        <p className="text-xs text-destructive">{message}</p>
        <button
          type="button"
          onClick={() => void retry()}
          disabled={isRetrying}
          className="text-xs font-medium text-accent underline underline-offset-2 disabled:opacity-50"
        >
          {retryLabel}
        </button>
      </div>
      {retryError && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {retryError}
        </p>
      )}
    </>
  );
}
