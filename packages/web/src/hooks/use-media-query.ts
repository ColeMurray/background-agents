"use client";

import { useState, useEffect } from "react";

const MOBILE_BREAKPOINT = "(max-width: 767px)";

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 * Returns `false` during SSR / before hydration to avoid mismatch.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** Convenience wrapper: true when viewport width ≤ 767px. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_BREAKPOINT);
}
