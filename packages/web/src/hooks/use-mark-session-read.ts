"use client";

import { useEffect } from "react";
import { useSWRConfig } from "swr";
import { useAuthSession } from "@/lib/auth-session";
import {
  applySessionReadResult,
  isSessionMessageRead,
  markMessageRead,
  scopeSessionReadOverlay,
  SessionReadRequestError,
} from "@/lib/session-read-state";

const SESSION_READ_RETRY_MS = 2_000;
const SESSION_READ_MAX_ATTEMPTS = 4;
const PERMANENT_FAILURE_STATUSES = new Set([400, 401, 403, 404, 405]);

/**
 * Opening a session reads its latest terminal message. Each message ID is
 * acknowledged once while the document is visible; a hidden tab waits for
 * visibility. Focus is not required, since the terminal pane holds it for
 * much of a working session. A message this viewer already read in this
 * page is not asked about again.
 *
 * Only a missing projection is retried: the message exists on the client,
 * so the server row will catch up. A `not_latest` result means a newer
 * message is on its way to the client, which acknowledges that one instead.
 */
export function useMarkSessionRead(sessionId: string, messageId: string | null): void {
  const { mutate } = useSWRConfig();
  const { data: authSession } = useAuthSession();
  const viewerId = authSession?.user.id ?? null;

  useEffect(() => {
    if (!messageId || !viewerId) return;
    scopeSessionReadOverlay(viewerId);
    if (isSessionMessageRead(sessionId, messageId)) return;
    let cancelled = false;
    let settled = false;
    let inFlight = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const attemptOnce = async (): Promise<"settled" | "retry"> => {
      try {
        const result = await markMessageRead(sessionId, messageId);
        applySessionReadResult(result, mutate, viewerId);
        return result.outcome === "no_terminal_message" ? "retry" : "settled";
      } catch (error) {
        if (
          error instanceof SessionReadRequestError &&
          PERMANENT_FAILURE_STATUSES.has(error.status)
        ) {
          return "settled";
        }
        console.error("Failed to mark session message read", error);
        return "retry";
      }
    };

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
      const disposition = await attemptOnce();
      inFlight = false;
      if (cancelled) return;
      if (disposition === "settled") {
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
  }, [messageId, mutate, sessionId, viewerId]);
}
