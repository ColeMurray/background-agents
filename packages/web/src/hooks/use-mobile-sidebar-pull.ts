"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

export const MOBILE_SIDEBAR_HOLD_MS = 300;

const HOLD_TOLERANCE_PX = 10;
const OPEN_THRESHOLD_PX = 72;

interface UseMobileSidebarPullOptions {
  isMobile: boolean;
  isSidebarOpen: boolean;
  getSidebarWidth: () => number;
  onOpen: () => void;
}

export function useMobileSidebarPull({
  isMobile,
  isSidebarOpen,
  getSidebarWidth,
  onOpen,
}: UseMobileSidebarPullOptions) {
  const [dragDistance, setDragDistance] = useState(0);
  const [dragProgress, setDragProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragDistanceRef = useRef(0);
  const sidebarWidthRef = useRef(0);
  const isDragActiveRef = useRef(false);
  const isEnabled = isMobile && !isSidebarOpen;

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearHoldTimer();
    dragStartRef.current = null;
    dragDistanceRef.current = 0;
    sidebarWidthRef.current = 0;
    isDragActiveRef.current = false;
    setDragDistance(0);
    setDragProgress(0);
    setIsDragging(false);
  }, [clearHoldTimer]);

  useEffect(() => {
    if (!isEnabled) reset();
  }, [isEnabled, reset]);

  useEffect(() => clearHoldTimer, [clearHoldTimer]);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!isEnabled || (event.pointerType === "mouse" && event.button !== 0)) return;

      const sidebarWidth = getSidebarWidth();
      if (sidebarWidth <= 0) return;

      reset();
      sidebarWidthRef.current = sidebarWidth;
      dragStartRef.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        isDragActiveRef.current = true;
        setIsDragging(true);
      }, MOBILE_SIDEBAR_HOLD_MS);
    },
    [getSidebarWidth, isEnabled, reset]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      if (!start) return;

      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;
      if (!isDragActiveRef.current) {
        if (Math.hypot(deltaX, deltaY) > HOLD_TOLERANCE_PX) reset();
        return;
      }

      if (Math.abs(deltaY) > Math.abs(deltaX)) {
        reset();
        return;
      }

      event.preventDefault();
      const distance = Math.min(sidebarWidthRef.current, Math.max(0, deltaX));
      dragDistanceRef.current = distance;
      setDragDistance(distance);
      setDragProgress(distance / sidebarWidthRef.current);
    },
    [reset]
  );

  const handlePointerUp = useCallback(() => {
    const shouldOpen = isDragActiveRef.current && dragDistanceRef.current >= OPEN_THRESHOLD_PX;
    reset();
    if (shouldOpen) onOpen();
  }, [onOpen, reset]);

  return {
    dragDistance,
    dragProgress,
    isDragging,
    reset,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}
