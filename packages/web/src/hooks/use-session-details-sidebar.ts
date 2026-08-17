"use client";

import { useCallback, useEffect, useState } from "react";

export const DEFAULT_SESSION_DETAILS_SIDEBAR_OPEN = true;
const SESSION_DETAILS_SIDEBAR_OPEN_STORAGE_KEY = "open-inspect-session-details-sidebar-open";

export function useSessionDetailsSidebar() {
  const [isOpen, setIsOpen] = useState(DEFAULT_SESSION_DETAILS_SIDEBAR_OPEN);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SESSION_DETAILS_SIDEBAR_OPEN_STORAGE_KEY);
      if (stored === "true" || stored === "false") {
        setIsOpen(stored === "true");
      }
    } catch {
      // Storage is optional; the sidebar keeps DEFAULT_SESSION_DETAILS_SIDEBAR_OPEN.
    }
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      localStorage.setItem(SESSION_DETAILS_SIDEBAR_OPEN_STORAGE_KEY, String(isOpen));
    } catch {
      // Continue with the in-memory preference when storage is unavailable.
    }
  }, [isHydrated, isOpen]);

  const toggle = useCallback(() => {
    setIsOpen((previous) => !previous);
  }, []);

  return { isOpen, toggle };
}
