"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

export function useLocalDateTime(timestamp: number | string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (timestamp == null) return null;
      return new Date(timestamp).toLocaleString();
    },
    () => null
  );
}
