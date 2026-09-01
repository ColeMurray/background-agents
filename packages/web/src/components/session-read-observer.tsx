"use client";

import { useEffect } from "react";
import type { SessionReadAttemptDisposition } from "@/lib/session-read-state";

const SESSION_READ_RETRY_MS = 2_000;
const SESSION_READ_MAX_ATTEMPTS = 4;

export function SessionReadObserver({
  messageId,
  enabled,
  onMarkMessageRead,
}: {
  messageId: string | null;
  enabled: boolean;
  onMarkMessageRead: (messageId: string) => Promise<SessionReadAttemptDisposition>;
}) {
  useEffect(() => {
    if (!enabled || !messageId) return;

    let attempts = 0;
    let cancelled = false;
    let requestInFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const attempt = async () => {
      if (
        cancelled ||
        requestInFlight ||
        attempts >= SESSION_READ_MAX_ATTEMPTS ||
        document.visibilityState !== "visible" ||
        !document.hasFocus()
      ) {
        return;
      }

      requestInFlight = true;
      attempts += 1;
      let disposition: SessionReadAttemptDisposition;
      try {
        disposition = await onMarkMessageRead(messageId);
      } catch (error) {
        console.error("Failed to mark active session message read", error);
        disposition = "retry";
      } finally {
        requestInFlight = false;
      }
      if (cancelled || disposition !== "retry" || attempts >= SESSION_READ_MAX_ATTEMPTS) return;

      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          void attempt();
        },
        SESSION_READ_RETRY_MS * 2 ** (attempts - 1)
      );
    };

    const handleActivation = () => {
      if (attempts >= SESSION_READ_MAX_ATTEMPTS) attempts = 0;
      void attempt();
    };

    document.addEventListener("visibilitychange", handleActivation);
    window.addEventListener("focus", handleActivation);
    void attempt();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleActivation);
      window.removeEventListener("focus", handleActivation);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, messageId, onMarkMessageRead]);

  return null;
}
