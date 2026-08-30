"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Tracks which row keys have an action in flight, for per-row disabled
 * states. `run` marks the key pending for the action's duration (also on
 * throw); actions on distinct keys are independent. Counted per key rather
 * than a boolean set: overlapping runs on one key (a double-click landing
 * before the disabled state paints) keep it pending until the last one
 * settles.
 */
export function usePendingKeys(): {
  pending: ReadonlySet<string>;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
} {
  const [pendingCounts, setPendingCounts] = useState<ReadonlyMap<string, number>>(new Map());

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setPendingCounts((prev) => new Map(prev).set(key, (prev.get(key) ?? 0) + 1));
    try {
      await action();
    } finally {
      setPendingCounts((prev) => {
        const next = new Map(prev);
        const remaining = (prev.get(key) ?? 1) - 1;
        if (remaining > 0) {
          next.set(key, remaining);
        } else {
          next.delete(key);
        }
        return next;
      });
    }
  }, []);

  const pending = useMemo(() => new Set(pendingCounts.keys()), [pendingCounts]);

  return { pending, run };
}
