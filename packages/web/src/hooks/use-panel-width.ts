"use client";

import { useEffect, useState, type RefObject } from "react";

/** Tracks the rendered width of an element in pixels via ResizeObserver. */
export function usePanelWidth(
  ref: RefObject<HTMLElement | null>,
  { enabled }: { enabled: boolean }
): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof ResizeObserver === "undefined") return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? element.getBoundingClientRect().width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);

  return width;
}
