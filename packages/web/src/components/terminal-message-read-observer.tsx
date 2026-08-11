"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { SessionReadAttemptDisposition } from "@/lib/session-read-state";

const SESSION_READ_RETRY_MS = 2_000;
const SESSION_READ_MAX_ATTEMPTS = 4;
const MEANINGFUL_VISIBLE_HEIGHT_PX = 48;

export function TerminalMessageReadObserver({
  messageId,
  enabled,
  onMarkMessageRead,
  children,
}: {
  messageId: string;
  enabled: boolean;
  onMarkMessageRead: (messageId: string) => Promise<SessionReadAttemptDisposition>;
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

  const attemptMarkMessageRead = useCallback(async () => {
    if (
      !enabledRef.current ||
      attemptsCompleteRef.current ||
      requestInFlightRef.current ||
      attemptCountRef.current >= SESSION_READ_MAX_ATTEMPTS ||
      !intersectingRef.current ||
      document.visibilityState !== "visible" ||
      !document.hasFocus()
    ) {
      return;
    }

    requestInFlightRef.current = true;
    attemptCountRef.current += 1;
    let disposition: SessionReadAttemptDisposition;
    try {
      disposition = await onMarkMessageRead(messageId);
    } catch (error) {
      console.error("Failed to mark visible terminal message read", error);
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
      attemptCountRef.current < SESSION_READ_MAX_ATTEMPTS
    ) {
      const retryDelayMs = SESSION_READ_RETRY_MS * 2 ** (attemptCountRef.current - 1);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        void attemptMarkMessageRead();
      }, retryDelayMs);
    }
  }, [messageId, onMarkMessageRead]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) void attemptMarkMessageRead();
  }, [attemptMarkMessageRead, enabled]);

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
          void attemptMarkMessageRead();
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
  }, [attemptMarkMessageRead]);

  useEffect(() => {
    const attempt = () => {
      if (attemptCountRef.current >= SESSION_READ_MAX_ATTEMPTS) {
        attemptCountRef.current = 0;
      }
      void attemptMarkMessageRead();
    };
    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("focus", attempt);
    return () => {
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("focus", attempt);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [attemptMarkMessageRead]);

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
