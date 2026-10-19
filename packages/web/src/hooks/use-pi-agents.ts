"use client";

import { useCallback } from "react";
import useSWR from "swr";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";

export interface PiAgentUsage {
  usage: {
    input: number;
    output: number;
    reasoning?: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  costUsd: number;
}

export interface PiAgentSnapshot {
  conversationId: number;
  parent?: { conversationId: number; entryId: number };
  owner?: { conversationId: number; taskId: number };
  status: "active" | "queued" | "idle";
  queued: number;
  tasks: Array<{
    id: number;
    kind: string;
    status: string;
    phase?: string;
    abortRequested: boolean;
  }>;
  usage: PiAgentUsage;
  lastMessage: { entryId: number; text: string } | null;
}

interface PiAgentsEnvelope {
  state: "completed";
  result: { agents: PiAgentSnapshot[] };
}

type PiAgentAction =
  | { action: "send" | "follow_up" | "steer"; conversationId: number; content: string }
  | { action: "cancel_exact"; taskId: number }
  | { action: "fork"; conversationId: number; entryId: number }
  | { action: "reset"; conversationId: number }
  | { action: "handoff"; conversationId: number; handoff: string }
  | { action: "compact"; conversationId: number; instructions?: string };

async function fetchPiAgents(path: BrowserApiPath): Promise<PiAgentsEnvelope> {
  const response = await browserApiFetch(path);
  if (!response.ok)
    throw new Error(await sessionActionErrorMessage(response, "Failed to load agents"));
  return (await response.json()) as PiAgentsEnvelope;
}

export function usePiAgents(sessionId: string, enabled: boolean) {
  const key = enabled
    ? (`/api/sessions/${encodeURIComponent(sessionId)}/pi/agents` satisfies BrowserApiPath)
    : null;
  const query = useSWR<PiAgentsEnvelope>(key, fetchPiAgents, {
    refreshInterval: (data) =>
      data?.result.agents.some((agent) => agent.status !== "idle") ? 2_000 : 10_000,
    keepPreviousData: true,
  });
  const mutate = query.mutate;
  const run = useCallback(
    async (action: PiAgentAction) => {
      const lifecycle =
        action.action === "cancel_exact" ||
        action.action === "reset" ||
        action.action === "handoff";
      const response = await browserApiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/pi/${lifecycle ? "lifecycle-control" : "control"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...action, requestId: crypto.randomUUID() }),
        }
      );
      if (!response.ok) {
        throw new Error(await sessionActionErrorMessage(response, "Pi agent action failed"));
      }
      await mutate();
      return response.json();
    },
    [mutate, sessionId]
  );
  return {
    agents: query.data?.result.agents ?? [],
    error: query.error instanceof Error ? query.error.message : null,
    isLoading: query.isLoading,
    isValidating: query.isValidating,
    refresh: query.mutate,
    run,
  };
}
