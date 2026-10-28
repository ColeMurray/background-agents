"use client";

import { createContext, useContext, useEffect, useRef } from "react";

const SettingsNavigationGuardContext = createContext<{ current: boolean } | null>(null);

function confirmDiscard(dirty: boolean) {
  return !dirty || window.confirm("Discard unsaved changes?");
}

export function SettingsNavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const dirty = useRef(false);
  useEffect(() => {
    // Native popstate can reach Next before page listeners, even with capture enabled.
    // Navigation API traversal events can be cancelled before the history entry changes.
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const onNavigate = (event: Event) => {
      const { navigationType, hashChange } = event as Event & {
        navigationType: string;
        hashChange: boolean;
      };
      if (
        navigationType === "traverse" &&
        !hashChange &&
        event.cancelable &&
        !confirmDiscard(dirty.current)
      ) {
        event.preventDefault();
      }
    };
    navigation?.addEventListener("navigate", onNavigate);
    return () => navigation?.removeEventListener("navigate", onNavigate);
  }, []);
  return (
    <SettingsNavigationGuardContext.Provider value={dirty}>
      {children}
    </SettingsNavigationGuardContext.Provider>
  );
}

export function useConfirmSettingsNavigation() {
  const dirty = useContext(SettingsNavigationGuardContext);
  return () => confirmDiscard(!!dirty?.current);
}

export function useSettingsUnsavedChanges(dirty: boolean) {
  const guard = useContext(SettingsNavigationGuardContext);
  useEffect(() => {
    if (guard) guard.current = dirty;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    if (dirty) window.addEventListener("beforeunload", warn);
    return () => {
      if (guard) guard.current = false;
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, guard]);
}
