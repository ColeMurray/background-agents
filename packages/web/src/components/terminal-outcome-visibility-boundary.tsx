"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { TerminalOutcomeAcknowledgement } from "@/lib/session-read-state";

const TERMINAL_ACK_RETRY_MS = 2_000;
const TERMINAL_ACK_MAX_ATTEMPTS = 4;
const MEANINGFUL_VISIBLE_HEIGHT_PX = 48;

interface TerminalAcknowledgementAttemptState {
  enabled: boolean;
  acknowledged: boolean;
  requestInFlight: boolean;
  attemptCount: number;
  intersecting: boolean;
  documentVisible: boolean;
  documentFocused: boolean;
}

export function shouldAttemptTerminalAcknowledgement(
  state: TerminalAcknowledgementAttemptState
): boolean {
  return (
    state.enabled &&
    !state.acknowledged &&
    !state.requestInFlight &&
    state.attemptCount < TERMINAL_ACK_MAX_ATTEMPTS &&
    state.intersecting &&
    state.documentVisible &&
    state.documentFocused
  );
}

export function TerminalOutcomeVisibilityBoundary({
  messageId,
  enabled,
  onVisible,
  children,
}: {
  messageId: string;
  enabled: boolean;
  onVisible: (messageId: string) => Promise<TerminalOutcomeAcknowledgement>;
  children: ReactNode;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const enabledRef = useRef(enabled);
  const intersectingRef = useRef(false);
  const acknowledgedRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptCountRef = useRef(0);
  const cancelledRef = useRef(false);

  const attemptAcknowledgement = useCallback(async () => {
    if (
      !shouldAttemptTerminalAcknowledgement({
        enabled: enabledRef.current,
        acknowledged: acknowledgedRef.current,
        requestInFlight: requestInFlightRef.current,
        attemptCount: attemptCountRef.current,
        intersecting: intersectingRef.current,
        documentVisible: document.visibilityState === "visible",
        documentFocused: document.hasFocus(),
      })
    ) {
      return;
    }

    requestInFlightRef.current = true;
    attemptCountRef.current += 1;
    let result: TerminalOutcomeAcknowledgement;
    try {
      result = await onVisible(messageId);
    } catch (error) {
      console.error("Failed to acknowledge visible terminal outcome", error);
      result = "retry";
    } finally {
      requestInFlightRef.current = false;
    }
    if (cancelledRef.current) return;

    acknowledgedRef.current = result !== "retry";

    if (
      result === "retry" &&
      enabledRef.current &&
      intersectingRef.current &&
      attemptCountRef.current < TERMINAL_ACK_MAX_ATTEMPTS
    ) {
      const retryDelayMs = TERMINAL_ACK_RETRY_MS * 2 ** (attemptCountRef.current - 1);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        void attemptAcknowledgement();
      }, retryDelayMs);
    }
  }, [messageId, onVisible]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) void attemptAcknowledgement();
  }, [attemptAcknowledgement, enabled]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visibleHeight = entry.intersectionRect?.height ?? MEANINGFUL_VISIBLE_HEIGHT_PX;
        const requiredHeight = Math.min(
          entry.boundingClientRect?.height ?? MEANINGFUL_VISIBLE_HEIGHT_PX,
          MEANINGFUL_VISIBLE_HEIGHT_PX
        );
        const meaningfullyVisible = entry.isIntersecting && visibleHeight >= requiredHeight;
        intersectingRef.current = meaningfullyVisible;
        if (meaningfullyVisible) {
          void attemptAcknowledgement();
        } else {
          attemptCountRef.current = 0;
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
      },
      { threshold: 0 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [attemptAcknowledgement]);

  useEffect(() => {
    const attempt = () => {
      if (attemptCountRef.current >= TERMINAL_ACK_MAX_ATTEMPTS) {
        attemptCountRef.current = 0;
      }
      void attemptAcknowledgement();
    };
    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("focus", attempt);
    return () => {
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("focus", attempt);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [attemptAcknowledgement]);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      intersectingRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  return (
    <div ref={elementRef} data-terminal-message-id={messageId}>
      {children}
    </div>
  );
}
