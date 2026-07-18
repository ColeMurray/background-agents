"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { mutate } from "swr";
import { sessionDiffStateSchema, type SessionDiffState } from "@open-inspect/shared";
import { parseDiffErrorBody } from "@/lib/session-diffs";

export function sessionDiffKey(sessionId: string): string {
  return `/api/sessions/${sessionId}/diff`;
}

export function useSessionDiffs(sessionId: string): {
  state: SessionDiffState | null;
  isLoading: boolean;
  error: Error | null;
} {
  const { data, error, isLoading } = useSWR<unknown>(sessionDiffKey(sessionId));
  const parsed = useMemo(
    () => (data === undefined ? null : sessionDiffStateSchema.safeParse(data)),
    [data]
  );
  const contractError =
    parsed && !parsed.success ? new Error("Invalid session changes response") : null;
  return {
    state: parsed?.success ? parsed.data : null,
    isLoading,
    error: error instanceof Error ? error : contractError,
  };
}

export function useSessionDiffRetry(sessionId: string): {
  retry: () => Promise<boolean>;
  isRetrying: boolean;
  retryError: string | null;
} {
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = useCallback(async () => {
    setIsRetrying(true);
    setRetryError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/diff/retry`, { method: "POST" });
      if (!response.ok) {
        const body = parseDiffErrorBody(await response.json().catch(() => null));
        setRetryError(body.error ?? "Changes could not be retried.");
        return false;
      }
      await mutate(sessionDiffKey(sessionId));
      return true;
    } catch {
      setRetryError("Changes could not be retried.");
      return false;
    } finally {
      setIsRetrying(false);
    }
  }, [sessionId]);
  return { retry, isRetrying, retryError };
}
