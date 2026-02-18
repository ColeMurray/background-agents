"use client";

import { useState, useEffect, useCallback } from "react";
import { MOBILE_BREAKPOINT } from "./use-media-query";

const SIDEBAR_STORAGE_KEY = "open-inspect-sidebar-open";

export function useSidebar() {
  const [isOpen, setIsOpen] = useState(true);
  const [isHydrated, setIsHydrated] = useState(false);

  // Load initial state from localStorage after hydration
  useEffect(() => {
    const isMobile = window.matchMedia(MOBILE_BREAKPOINT).matches;
    if (isMobile) {
      setIsOpen(false);
    } else {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored !== null) {
        setIsOpen(stored === "true");
      }
    }
    setIsHydrated(true);
  }, []);

  // Persist state to localStorage
  useEffect(() => {
    if (isHydrated) {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(isOpen));
    }
  }, [isOpen, isHydrated]);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  return {
    isOpen,
    isHydrated,
    toggle,
    open,
    close,
  };
}
