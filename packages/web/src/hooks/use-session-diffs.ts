"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { mutate } from "swr";
import {
  sessionDiffStateSchema,
  type SessionDiffState,
} from "@open-inspect/shared/types/session-diffs";
import { parseDiffErrorBody } from "@/lib/session-diffs";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";
import { toast } from "sonner";

export function sessionDiffKey(sessionId: string): BrowserApiPath {
  return `/api/sessions/${sessionId}/diff`;
}

export interface SessionDiffRefresh {
  error: Error | null;
  isValidating: boolean;
  retry: () => Promise<void>;
}

export function useSessionDiffs(sessionId: string): {
  state: SessionDiffState | null;
  isLoading: boolean;
  refresh: SessionDiffRefresh;
} {
  const [lastRefreshError, setLastRefreshError] = useState<Error | null>(null);
  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate: revalidate,
  } = useSWR<unknown>(sessionDiffKey(sessionId), {
    onError: (refreshError) => {
      setLastRefreshError(
        refreshError instanceof Error ? refreshError : new Error("Unable to refresh changes")
      );
    },
    onSuccess: () => setLastRefreshError(null),
  });
  const parsed = useMemo(
    () => (data === undefined ? null : sessionDiffStateSchema.safeParse(data)),
    [data]
  );
  const contractError =
    parsed && !parsed.success ? new Error("Invalid session changes response") : null;
  const currentError = error instanceof Error ? error : contractError;
  const retry = useCallback(async () => {
    await revalidate(undefined, { revalidate: true, throwOnError: false });
  }, [revalidate]);
  return {
    state: parsed?.success ? parsed.data : null,
    isLoading,
    refresh: {
      error: currentError ?? (isValidating ? lastRefreshError : null),
      isValidating,
      retry,
    },
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
      const response = await browserApiFetch(`/api/sessions/${sessionId}/diff/retry`, {
        method: "POST",
      });
      if (!response.ok) {
        if (response.status === 403) {
          const message = await sessionActionErrorMessage(
            response,
            "Changes could not be retried."
          );
          setRetryError(message);
          toast.error(message);
          return false;
        }
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
