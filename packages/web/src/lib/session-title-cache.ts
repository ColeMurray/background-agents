import type { ScopedMutator } from "swr";
import {
  applySessionInboxTitleUpdate,
  isSessionInboxKey,
  type SessionInboxPage,
  type SessionInboxSnapshot,
} from "@/lib/session-inbox-api";
import { applyTitleUpdate, isSessionListKey, type SessionListResponse } from "@/lib/session-list";

/**
 * Project an authoritative title into both D1-backed cache families. Do not
 * revalidate here: the asynchronous D1 projection may still contain an older
 * title than the session authority.
 */
export function applySessionTitleToCaches(
  mutate: ScopedMutator,
  sessionId: string,
  title: string | null
) {
  return Promise.all([
    mutate<SessionListResponse>(
      isSessionListKey,
      (current) => applyTitleUpdate(current, sessionId, title),
      { populateCache: true, revalidate: false }
    ),
    mutate<SessionInboxSnapshot | SessionInboxPage>(
      isSessionInboxKey,
      (current) => applySessionInboxTitleUpdate(current, sessionId, title),
      { populateCache: true, revalidate: false }
    ),
  ]);
}
