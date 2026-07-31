"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

const DIRECTION_LOCK_THRESHOLD_PX = 8;
const OPEN_THRESHOLD_PX = 72;
const PULL_START_MIN_X_PX = 24;
const PULL_START_MAX_X_PX = 48;

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
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragDistanceRef = useRef(0);
  const sidebarWidthRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);
  const isEnabled = isMobile && !isSidebarOpen;

  const reset = useCallback(() => {
    dragStartRef.current = null;
    dragDistanceRef.current = 0;
    sidebarWidthRef.current = 0;
    activePointerIdRef.current = null;
    setDragDistance(0);
    setDragProgress(0);
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (!isEnabled) reset();
  }, [isEnabled, reset]);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!isEnabled || (event.pointerType === "mouse" && event.button !== 0)) return;
      if (activePointerIdRef.current !== null) return;
      if (event.clientX < PULL_START_MIN_X_PX || event.clientX > PULL_START_MAX_X_PX) return;

      const sidebarWidth = getSidebarWidth();
      if (sidebarWidth <= 0) return;

      reset();
      activePointerIdRef.current = event.pointerId;
      sidebarWidthRef.current = sidebarWidth;
      dragStartRef.current = { x: event.clientX, y: event.clientY };
      setIsDragging(true);
    },
    [getSidebarWidth, isEnabled, reset]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (activePointerIdRef.current !== event.pointerId) return;

      const start = dragStartRef.current;
      if (!start) return;

      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;
      if (Math.hypot(deltaX, deltaY) < DIRECTION_LOCK_THRESHOLD_PX) return;

      if (deltaX <= 0 || Math.abs(deltaY) > deltaX) {
        reset();
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const distance = Math.min(sidebarWidthRef.current, Math.max(0, deltaX));
      dragDistanceRef.current = distance;
      setDragDistance(distance);
      setDragProgress(distance / sidebarWidthRef.current);
    },
    [reset]
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (activePointerIdRef.current !== event.pointerId) return;

      const shouldOpen = dragDistanceRef.current >= OPEN_THRESHOLD_PX;
      reset();
      if (shouldOpen) onOpen();
    },
    [onOpen, reset]
  );

  const handlePointerCancel = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (activePointerIdRef.current === event.pointerId) reset();
    },
    [reset]
  );

  return {
    dragDistance,
    dragProgress,
    isDragging,
    reset,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  };
}
