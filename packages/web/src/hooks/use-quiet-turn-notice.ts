"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRenderableTimelineEvent } from "@/lib/timeline-items";
import type { SessionSocketState } from "@/lib/session-socket/reducer";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";

export const QUIET_TURN_NOTICE_DELAY_MS = 5 * 60_000;
// Presentation freshness only: missing two normal socket pong intervals must
// suppress reassurance, without changing transport or execution policy.
export const QUIET_TURN_CONNECTION_FRESHNESS_MS = 60_000;

type QuietTurnState = Pick<SessionSocketState, "ready" | "sessionState" | "events" | "promptQueue">;

/** A transient status, never an event, warning, or evidence of execution progress. */
export function useQuietTurnNotice(state: QuietTurnState) {
  const processingMessageId = state.promptQueue.find(
    (item) => item.status === "processing"
  )?.messageId;
  const activeMessageId =
    state.ready &&
    state.sessionState?.isProcessing &&
    state.sessionState.sandboxStatus === "ready" &&
    state.sessionState.status === "active"
      ? (processingMessageId ?? null)
      : null;
  const lastTimelineActivityMs = useMemo(() => {
    if (!activeMessageId) return null;
    let latestMs: number | null = null;
    for (const event of state.events) {
      if (!("messageId" in event) || event.messageId !== activeMessageId) continue;
      // Completion may arrive before the queue / processing-status update.
      if (event.type === "execution_complete") return null;
      if (isRenderableTimelineEvent(event)) {
        latestMs = Math.max(latestMs ?? 0, event.timestamp * 1000);
      }
    }
    return latestMs;
  }, [activeMessageId, state.events]);
  const lastReceivedAtMsRef = useRef<number | null>(null);
  // Token output is buffered outside the rendered timeline. It still ends a
  // quiet interval immediately; do not wait for the final assistant bubble.
  const tokenActivityMsRef = useRef(new Map<string, number>());
  const stoppedMessageIdRef = useRef<string | null>(null);
  const [quietMessageId, setQuietMessageId] = useState<string | null>(null);

  const observeMessage = useCallback((message: ServerMessage) => {
    lastReceivedAtMsRef.current = Date.now();
    if (message.type === "subscribed") {
      // Reconnect replaces the timeline. Discard client-only activity and
      // derive the initial notice from that authoritative replacement.
      tokenActivityMsRef.current.clear();
      setQuietMessageId(null);
    } else if (
      message.type === "sandbox_event" &&
      message.event.type === "token" &&
      message.event.content
    ) {
      const messageId = message.event.messageId;
      tokenActivityMsRef.current.set(messageId, Date.now());
      setQuietMessageId((current) => (current === messageId ? null : current));
    }
  }, []);

  const dismissForStop = useCallback(() => {
    stoppedMessageIdRef.current = processingMessageId ?? null;
    setQuietMessageId(null);
  }, [processingMessageId]);

  useEffect(() => {
    // Retain no token history from other messages. A Stop remains scoped to
    // its message even if the connection drops before confirmation arrives.
    for (const messageId of tokenActivityMsRef.current.keys()) {
      if (messageId !== processingMessageId) tokenActivityMsRef.current.delete(messageId);
    }
    const update = () => {
      const nowMs = Date.now();
      const receivedAtMs = lastReceivedAtMsRef.current;
      const lastActivityMs =
        activeMessageId && lastTimelineActivityMs !== null
          ? Math.max(lastTimelineActivityMs, tokenActivityMsRef.current.get(activeMessageId) ?? 0)
          : null;
      setQuietMessageId(
        activeMessageId &&
          activeMessageId !== stoppedMessageIdRef.current &&
          receivedAtMs !== null &&
          nowMs - receivedAtMs < QUIET_TURN_CONNECTION_FRESHNESS_MS &&
          lastActivityMs !== null &&
          nowMs - lastActivityMs >= QUIET_TURN_NOTICE_DELAY_MS
          ? activeMessageId
          : null
      );
    };
    update();
    if (!activeMessageId) return;
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [activeMessageId, lastTimelineActivityMs, processingMessageId]);

  return {
    quietTurnMessageId:
      lastTimelineActivityMs !== null && activeMessageId === quietMessageId ? quietMessageId : null,
    observeMessage,
    dismissForStop,
  };
}
