"use client";

import { useEffect, useState } from "react";
import type { LayoutStorage } from "react-resizable-panels";

const SERVER_LAYOUT_STORAGE: LayoutStorage = {
  getItem: () => null,
  setItem: () => undefined,
};

function getBrowserLayoutStorage(): LayoutStorage {
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return SERVER_LAYOUT_STORAGE;
  }
  return {
    getItem: (key) => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        storage.setItem(key, value);
      } catch {
        // Layout persistence is optional; keep the session usable when denied.
      }
    },
  };
}

/** Defers browser-only panel persistence until after hydration. */
export function useBrowserLayoutStorage(): LayoutStorage {
  const [storage, setStorage] = useState<LayoutStorage>(SERVER_LAYOUT_STORAGE);

  useEffect(() => setStorage(getBrowserLayoutStorage()), []);

  return storage;
}
