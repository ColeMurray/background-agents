"use client";

import { useCallback, useState } from "react";

/**
 * Tracks which row keys have an action in flight, for per-row disabled
 * states. `run` marks the key pending for the action's duration (also on
 * throw); actions on distinct keys are independent.
 */
export function usePendingKeys(): {
  pending: ReadonlySet<string>;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
} {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setPending((prev) => new Set(prev).add(key));
    try {
      await action();
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  return { pending, run };
}
