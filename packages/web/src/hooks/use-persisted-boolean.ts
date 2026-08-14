"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Boolean preference that hydrates from localStorage after mount so SSR and the
 * first client paint stay aligned, then persists subsequent updates.
 */
export function usePersistedBoolean(storageKey: string, defaultValue: boolean) {
  const [value, setValueState] = useState(defaultValue);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === "true" || stored === "false") {
        setValueState(stored === "true");
      }
    } catch {
      // Storage is optional; keep the default when unavailable.
    }
  }, [storageKey]);

  const setValue = useCallback(
    (next: boolean) => {
      setValueState(next);
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        // Continue with the in-memory preference when storage is unavailable.
      }
    },
    [storageKey]
  );

  const toggle = useCallback(() => {
    setValueState((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        // Continue with the in-memory preference when storage is unavailable.
      }
      return next;
    });
  }, [storageKey]);

  return { value, setValue, toggle };
}
