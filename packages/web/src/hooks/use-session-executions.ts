"use client";

import { useCallback } from "react";
import useSWR from "swr";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";
import {
  sessionExecutionOutputSchema,
  sessionExecutionsEnvelopeSchema,
} from "@/lib/session-executions";

async function fetchExecutions(path: BrowserApiPath) {
  const response = await browserApiFetch(path);
  if (!response.ok)
    throw new Error(await sessionActionErrorMessage(response, "Failed to load executions"));
  return sessionExecutionsEnvelopeSchema.parse(await response.json());
}

export function useSessionExecutions(sessionId: string, enabled: boolean) {
  const encodedSessionId = encodeURIComponent(sessionId);
  const query = useSWR(
    enabled ? (`/api/sessions/${encodedSessionId}/executions` satisfies BrowserApiPath) : null,
    fetchExecutions,
    {
      refreshInterval: (data) =>
        data?.commands.some((command) =>
          ["queued", "dispatched", "running", "cancelling"].includes(command.state)
        )
          ? 2_000
          : 10_000,
      keepPreviousData: true,
    }
  );
  const mutate = query.mutate;
  const cancel = useCallback(
    async (commandId: string) => {
      const response = await browserApiFetch(
        `/api/sessions/${encodedSessionId}/executions/${encodeURIComponent(commandId)}/cancel`,
        { method: "POST" }
      );
      if (!response.ok)
        throw new Error(await sessionActionErrorMessage(response, "Cancellation failed"));
      await mutate();
    },
    [encodedSessionId, mutate]
  );
  const output = useCallback(
    async (commandId: string) => {
      const response = await browserApiFetch(
        `/api/sessions/${encodedSessionId}/executions/${encodeURIComponent(commandId)}/output?afterSequence=-1&limitBytes=65536`
      );
      if (!response.ok)
        throw new Error(await sessionActionErrorMessage(response, "Output unavailable"));
      return sessionExecutionOutputSchema.parse(await response.json());
    },
    [encodedSessionId]
  );
  return {
    commands: query.data?.commands ?? [],
    error: query.error instanceof Error ? query.error.message : null,
    isLoading: query.isLoading,
    cancel,
    output,
  };
}
