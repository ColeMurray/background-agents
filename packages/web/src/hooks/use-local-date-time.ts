"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/** Render a deterministic server value, then switch to the browser's locale after hydration. */
export function useLocalDateTime(value: string | number | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (value == null ? null : new Date(value).toLocaleString()),
    () => (value == null ? null : new Date(value).toISOString())
  );
}
