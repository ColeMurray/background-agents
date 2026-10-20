"use client";

import { useCallback } from "react";
import useSWR from "swr";
import {
  externalActionPendingListSchema,
  type ExternalActionPendingList,
} from "@open-inspect/shared/types/external-actions";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";

export function sessionExternalActionsKey(sessionId: string): BrowserApiPath {
  return `/api/sessions/${sessionId}/external-actions`;
}

async function fetchPendingActions(path: BrowserApiPath): Promise<ExternalActionPendingList> {
  const response = await browserApiFetch(path);
  if (!response.ok) {
    throw new Error(await sessionActionErrorMessage(response, "Failed to load pending actions"));
  }
  return externalActionPendingListSchema.parse(await response.json());
}

/**
 * Pending external effects for one session.
 *
 * The list is served by the control plane, which owns the approval ledger and
 * the session's authorization. The browser never decides what it may approve.
 */
export function useSessionExternalActions(sessionId: string, enabled: boolean) {
  const query = useSWR<ExternalActionPendingList>(
    enabled ? sessionExternalActionsKey(sessionId) : null,
    fetchPendingActions,
    { keepPreviousData: true, revalidateOnFocus: true }
  );
  const mutate = query.mutate;
  const decide = useCallback(
    async (actionId: string, decision: "approve" | "deny", reason?: string) => {
      const response = await browserApiFetch(
        `/api/sessions/${sessionId}/external-actions/${encodeURIComponent(actionId)}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reason ? { decision, reason } : { decision }),
        }
      );
      if (!response.ok) {
        throw new Error(await sessionActionErrorMessage(response, "The decision was not accepted"));
      }
      await mutate();
    },
    [mutate, sessionId]
  );
  return {
    actions: query.data?.actions ?? [],
    nextCursor: query.data?.nextCursor ?? null,
    error: query.error instanceof Error ? query.error.message : null,
    isLoading: query.isLoading,
    decide,
    refresh: () => mutate(undefined, { revalidate: true, throwOnError: false }),
  };
}
