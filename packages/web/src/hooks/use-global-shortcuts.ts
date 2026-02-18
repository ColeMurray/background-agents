"use client";

import { useEffect } from "react";
import { matchGlobalShortcut, shouldIgnoreGlobalShortcut } from "@/lib/keyboard-shortcuts";

interface UseGlobalShortcutsOptions {
  enabled?: boolean;
  onNewSession: () => void;
  onToggleSidebar: () => void;
}

export function useGlobalShortcuts({
  enabled = true,
  onNewSession,
  onToggleSidebar,
}: UseGlobalShortcutsOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreGlobalShortcut(event)) return;

      const action = matchGlobalShortcut(event);
      if (!action) return;

      event.preventDefault();

      if (action === "new-session") {
        onNewSession();
        return;
      }

      onToggleSidebar();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onNewSession, onToggleSidebar]);
}
