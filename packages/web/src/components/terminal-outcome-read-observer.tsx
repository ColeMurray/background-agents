"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { TerminalOutcomeReadAttemptDisposition } from "@/lib/session-terminal-outcome-read-state";

const TERMINAL_OUTCOME_READ_RETRY_MS = 2_000;
const TERMINAL_OUTCOME_READ_MAX_ATTEMPTS = 4;
const MEANINGFUL_VISIBLE_HEIGHT_PX = 48;

interface TerminalOutcomeReadAttemptState {
  enabled: boolean;
  attemptsComplete: boolean;
  requestInFlight: boolean;
  attemptCount: number;
  intersecting: boolean;
  documentVisible: boolean;
  documentFocused: boolean;
}

export function shouldAttemptMarkTerminalOutcomeRead(
  state: TerminalOutcomeReadAttemptState
): boolean {
  return (
    state.enabled &&
    !state.attemptsComplete &&
    !state.requestInFlight &&
    state.attemptCount < TERMINAL_OUTCOME_READ_MAX_ATTEMPTS &&
    state.intersecting &&
    state.documentVisible &&
    state.documentFocused
  );
}

export function TerminalOutcomeReadObserver({
  messageId,
  enabled,
  onMarkTerminalOutcomeRead,
  children,
}: {
  messageId: string;
  enabled: boolean;
  onMarkTerminalOutcomeRead: (messageId: string) => Promise<TerminalOutcomeReadAttemptDisposition>;
  children: ReactNode;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const enabledRef = useRef(enabled);
  const intersectingRef = useRef(false);
  const attemptsCompleteRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptCountRef = useRef(0);
  const cancelledRef = useRef(false);

  const attemptMarkTerminalOutcomeRead = useCallback(async () => {
    if (
      !shouldAttemptMarkTerminalOutcomeRead({
        enabled: enabledRef.current,
        attemptsComplete: attemptsCompleteRef.current,
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
    let disposition: TerminalOutcomeReadAttemptDisposition;
    try {
      disposition = await onMarkTerminalOutcomeRead(messageId);
    } catch (error) {
      console.error("Failed to mark visible terminal outcome read", error);
      disposition = "retry";
    } finally {
      requestInFlightRef.current = false;
    }
    if (cancelledRef.current) return;

    attemptsCompleteRef.current = disposition !== "retry";

    if (
      disposition === "retry" &&
      enabledRef.current &&
      intersectingRef.current &&
      attemptCountRef.current < TERMINAL_OUTCOME_READ_MAX_ATTEMPTS
    ) {
      const retryDelayMs = TERMINAL_OUTCOME_READ_RETRY_MS * 2 ** (attemptCountRef.current - 1);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        void attemptMarkTerminalOutcomeRead();
      }, retryDelayMs);
    }
  }, [messageId, onMarkTerminalOutcomeRead]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) void attemptMarkTerminalOutcomeRead();
  }, [attemptMarkTerminalOutcomeRead, enabled]);

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
          void attemptMarkTerminalOutcomeRead();
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
  }, [attemptMarkTerminalOutcomeRead]);

  useEffect(() => {
    const attempt = () => {
      if (attemptCountRef.current >= TERMINAL_OUTCOME_READ_MAX_ATTEMPTS) {
        attemptCountRef.current = 0;
      }
      void attemptMarkTerminalOutcomeRead();
    };
    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("focus", attempt);
    return () => {
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("focus", attempt);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [attemptMarkTerminalOutcomeRead]);

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
