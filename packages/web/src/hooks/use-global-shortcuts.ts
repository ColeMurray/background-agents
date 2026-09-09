"use client";

import { useEffect } from "react";
import { matchGlobalShortcut, shouldIgnoreGlobalShortcutForAction } from "@/lib/keyboard-shortcuts";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

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
  const { shortcuts } = useKeyboardShortcuts();
  const { hasPermission } = useCurrentUserAuthorization();
  const canCreateSession = hasPermission("sessions.create");
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = matchGlobalShortcut(event, shortcuts);
      if (!action) return;
      if (shouldIgnoreGlobalShortcutForAction(event, action)) return;
      if (action === "new-session" && !canCreateSession) return;

      event.preventDefault();

      if (action === "open-command-menu") return onOpenCommandMenu();
      if (action === "new-session") return onNewSession();
      return onToggleSidebar();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canCreateSession, enabled, onNewSession, onOpenCommandMenu, onToggleSidebar, shortcuts]);
}
