"use client";

import { useCallback, useEffect, useState } from "react";

export const SESSION_INSPECTOR_TABS = ["changes", "info", "tasks", "tools"] as const;
export type SessionInspectorTab = (typeof SESSION_INSPECTOR_TABS)[number];

const DEFAULT_SESSION_INSPECTOR_TAB: SessionInspectorTab = "changes";
const SESSION_INSPECTOR_TAB_STORAGE_KEY = "open-inspect-session-inspector-tab";

export function isSessionInspectorTab(value: unknown): value is SessionInspectorTab {
  return SESSION_INSPECTOR_TABS.some((tab) => tab === value);
}

/**
 * The session inspector tab this browser last chose. Starts on the default so
 * the server and the client render the same markup, then adopts the stored
 * choice after hydration.
 */
export function useSessionInspectorTab() {
  const [tab, setTab] = useState<SessionInspectorTab>(DEFAULT_SESSION_INSPECTOR_TAB);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SESSION_INSPECTOR_TAB_STORAGE_KEY);
      if (isSessionInspectorTab(stored)) setTab(stored);
    } catch {
      // Storage is optional; the inspector opens on DEFAULT_SESSION_INSPECTOR_TAB.
    }
  }, []);

  const selectTab = useCallback((next: SessionInspectorTab) => {
    setTab(next);
    try {
      localStorage.setItem(SESSION_INSPECTOR_TAB_STORAGE_KEY, next);
    } catch {
      // Continue with the in-memory choice when storage is unavailable.
    }
  }, []);

  return { tab, selectTab };
}
