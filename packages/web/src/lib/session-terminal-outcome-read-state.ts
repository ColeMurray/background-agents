import { mutate } from "swr";
import { browserApiFetch } from "./browser-api-fetch";
import {
  applySessionTerminalOutcomeReadState,
  isSessionListKey,
  type SessionListResponse,
} from "./session-list";
import {
  sessionTerminalOutcomeReadResultSchema,
  type SessionTerminalOutcomeReadAction,
  type SessionTerminalOutcomeReadResult,
  type SessionTerminalOutcomeReadState,
} from "@open-inspect/shared";

export type TerminalOutcomeReadAttemptDisposition = "complete" | "retry" | "permanent_failure";

export class SessionTerminalOutcomeReadRequestError extends Error {
  constructor(readonly status: number) {
    super(`Failed to update terminal-outcome read state: ${status}`);
    this.name = "SessionTerminalOutcomeReadRequestError";
  }
}

async function patchSessionTerminalOutcomeReadState(
  sessionId: string,
  action: SessionTerminalOutcomeReadAction
): Promise<SessionTerminalOutcomeReadResult> {
  const response = await browserApiFetch(`/api/sessions/${sessionId}/terminal-outcome-read-state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new SessionTerminalOutcomeReadRequestError(response.status);
  return sessionTerminalOutcomeReadResultSchema.parse(await response.json());
}

export function classifyTerminalOutcomeReadAttempt(
  result: SessionTerminalOutcomeReadResult
): TerminalOutcomeReadAttemptDisposition {
  return result.outcome === "marked_read" || result.outcome === "already_read"
    ? "complete"
    : "retry";
}

export function markTerminalOutcomeRead(
  sessionId: string,
  terminalOutcomeMessageId: string
): Promise<SessionTerminalOutcomeReadResult> {
  return patchSessionTerminalOutcomeReadState(sessionId, {
    action: "mark_terminal_outcome_read",
    terminalOutcomeMessageId,
  });
}

export function markLatestTerminalOutcomeRead(
  sessionId: string
): Promise<SessionTerminalOutcomeReadResult> {
  return patchSessionTerminalOutcomeReadState(sessionId, {
    action: "mark_latest_terminal_outcome_read",
  });
}

export function terminalOutcomeReadStateFromResult(
  result: SessionTerminalOutcomeReadResult
): SessionTerminalOutcomeReadState {
  return result.latestTerminalOutcomeMessageId === null
    ? {
        latestTerminalOutcomeMessageId: null,
        hasUnreadTerminalOutcome: false,
      }
    : {
        latestTerminalOutcomeMessageId: result.latestTerminalOutcomeMessageId,
        hasUnreadTerminalOutcome: result.hasUnreadTerminalOutcome,
      };
}

export function reconcileSessionTerminalOutcomeReadState(
  result: SessionTerminalOutcomeReadResult
): Promise<unknown> {
  const terminalOutcomeReadState = terminalOutcomeReadStateFromResult(result);
  return mutate<SessionListResponse>(
    isSessionListKey,
    (current) =>
      applySessionTerminalOutcomeReadState(current, result.sessionId, terminalOutcomeReadState),
    { populateCache: true, revalidate: false }
  );
}
