"use client";

import { useEffect } from "react";
import {
  classifySessionReadAttempt,
  markMessageRead,
  reconcileSessionReadState,
  SessionReadRequestError,
  type SessionReadAttemptDisposition,
} from "@/lib/session-read-state";

const SESSION_READ_RETRY_MS = 2_000;
const SESSION_READ_MAX_ATTEMPTS = 4;
const PERMANENT_FAILURE_STATUSES = new Set([400, 401, 403, 404, 405]);

async function attemptMarkMessageRead(
  sessionId: string,
  messageId: string
): Promise<SessionReadAttemptDisposition> {
  try {
    const result = await markMessageRead(sessionId, messageId);
    await reconcileSessionReadState(result);
    return classifySessionReadAttempt(result);
  } catch (error) {
    if (error instanceof SessionReadRequestError && PERMANENT_FAILURE_STATUSES.has(error.status)) {
      return "permanent_failure";
    }
    console.error("Failed to mark session message read", error);
    return "retry";
  }
}

/**
 * Opening a session reads its latest terminal message. Each message ID is
 * acknowledged once while the document is visible; a hidden tab waits for
 * visibility. Focus is not required, since the terminal pane holds it for
 * much of a working session.
 */
export function useMarkSessionRead(sessionId: string, messageId: string | null): void {
  useEffect(() => {
    if (!messageId) return;
    let cancelled = false;
    let settled = false;
    let inFlight = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const attempt = async () => {
      if (
        cancelled ||
        settled ||
        inFlight ||
        attempts >= SESSION_READ_MAX_ATTEMPTS ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      inFlight = true;
      attempts += 1;
      const disposition = await attemptMarkMessageRead(sessionId, messageId);
      inFlight = false;
      if (cancelled) return;
      if (disposition !== "retry") {
        settled = true;
        return;
      }
      if (attempts < SESSION_READ_MAX_ATTEMPTS) {
        retryTimer = setTimeout(
          () => {
            retryTimer = null;
            void attempt();
          },
          SESSION_READ_RETRY_MS * 2 ** (attempts - 1)
        );
      }
    };
    const onVisibilityChange = () => {
      // A visible tab attempts now; the pending backoff must not attempt again.
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      void attempt();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void attempt();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [messageId, sessionId]);
}
