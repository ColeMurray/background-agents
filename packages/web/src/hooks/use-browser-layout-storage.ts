"use client";

import { useEffect, useState } from "react";
import type { LayoutStorage } from "react-resizable-panels";

const SERVER_LAYOUT_STORAGE: LayoutStorage = {
  getItem: () => null,
  setItem: () => undefined,
};

/** Defers browser-only panel persistence until after hydration. */
export function useBrowserLayoutStorage(): LayoutStorage {
  const [storage, setStorage] = useState<LayoutStorage>(SERVER_LAYOUT_STORAGE);

  useEffect(() => setStorage(window.localStorage), []);

  return storage;
}
