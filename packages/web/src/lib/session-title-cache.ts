import type { Cache, ScopedMutator } from "swr";
import {
  applySessionInboxTitleUpdate,
  isSessionInboxKey,
  isSessionInboxPaginationKey,
  type SessionInboxPage,
  type SessionInboxSnapshot,
} from "@/lib/session-inbox-api";
import { applyTitleUpdate, isSessionListKey, type SessionListResponse } from "@/lib/session-list";

interface SwrCacheState {
  data?: unknown;
  _k?: unknown;
}

/**
 * Updates only entries that already contain data. Mutating an unloaded SWR
 * key invalidates its in-flight request and can leave it empty; fetched
 * projections merge the recorded authoritative revision at parse time.
 */
export function applySessionTitleToCaches(
  mutate: ScopedMutator,
  cache: Cache,
  sessionId: string,
  title: string | null,
  updatedAt?: number
) {
  const updates: Array<Promise<unknown>> = [];

  for (const serializedKey of cache.keys()) {
    const state = cache.get(serializedKey) as SwrCacheState | undefined;
    if (state?.data === undefined) continue;
    const key = state._k ?? serializedKey;

    if (isSessionListKey(key)) {
      updates.push(
        mutate<SessionListResponse>(
          key,
          (current) => applyTitleUpdate(current, sessionId, title, updatedAt),
          { populateCache: true, revalidate: false }
        )
      );
    } else if (isSessionInboxKey(key) || isSessionInboxPaginationKey(key)) {
      updates.push(
        mutate<SessionInboxSnapshot | SessionInboxPage>(
          key,
          (current) => applySessionInboxTitleUpdate(current, sessionId, title, updatedAt),
          { populateCache: true, revalidate: false }
        )
      );
    }
  }

  return Promise.all(updates);
}
