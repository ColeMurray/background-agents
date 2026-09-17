"use client";

import { useCallback, useSyncExternalStore } from "react";

export const MOBILE_BREAKPOINT = "(max-width: 767px)";

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 * Returns `false` during SSR / before hydration to avoid mismatch.
 */
export function useMediaQuery(query: string): boolean {
  return useMediaQuerySnapshot(query) ?? false;
}

const getServerSnapshot = () => undefined;

/** The viewport is unknown during SSR and hydration; client mounts read it immediately. */
export function useMediaQuerySnapshot(query: string): boolean | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query]
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Convenience wrapper: true when viewport width ≤ 767px. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_BREAKPOINT);
}
