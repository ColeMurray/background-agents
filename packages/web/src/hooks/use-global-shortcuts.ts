"use client";

import { useEffect } from "react";
import { matchGlobalShortcut, shouldIgnoreGlobalShortcutForAction } from "@/lib/keyboard-shortcuts";

interface UseGlobalShortcutsOptions {
  enabled?: boolean;
  onOpenCommandMenu: () => void;
  onNewSession: () => void;
  onToggleSidebar: () => void;
}

export function useGlobalShortcuts({
  enabled = true,
  onOpenCommandMenu,
  onNewSession,
  onToggleSidebar,
}: UseGlobalShortcutsOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = matchGlobalShortcut(event);
      if (!action) return;
      if (shouldIgnoreGlobalShortcutForAction(event, action)) return;

      event.preventDefault();

      if (action === "open-command-menu") return onOpenCommandMenu();
      if (action === "new-session") return onNewSession();
      return onToggleSidebar();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onNewSession, onOpenCommandMenu, onToggleSidebar]);
}
