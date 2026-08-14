"use client";

import { useCallback, useEffect, useState } from "react";

const SESSION_DETAILS_SIDEBAR_OPEN_STORAGE_KEY = "open-inspect-session-details-sidebar-open";

export function useSessionDetailsSidebar() {
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SESSION_DETAILS_SIDEBAR_OPEN_STORAGE_KEY);
      if (stored === "true" || stored === "false") {
        setIsOpen(stored === "true");
      }
    } catch {
      // Storage is optional; the sidebar remains open when it is unavailable.
    }
  }, []);

  const toggle = useCallback(() => {
    const next = !isOpen;
    setIsOpen(next);
    try {
      localStorage.setItem(SESSION_DETAILS_SIDEBAR_OPEN_STORAGE_KEY, String(next));
    } catch {
      // Continue with the in-memory preference when storage is unavailable.
    }
  }, [isOpen]);

  return { isOpen, toggle };
}
