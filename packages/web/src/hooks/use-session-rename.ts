"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { applyTitleUpdate, isSessionListKey, type SessionListResponse } from "@/lib/session-list";
import {
  applySessionInboxTitleUpdate,
  isSessionInboxKey,
  type SessionInboxPage,
  type SessionInboxSnapshot,
} from "@/lib/session-inbox-api";

type SessionCacheMutator = ReturnType<typeof useSWRConfig>["mutate"];

/**
 * A session's title is cached in two payload families: session-list responses
 * and inbox snapshots/pages. Every optimistic update, settlement, and rollback
 * must touch both, or the sidebar inbox briefly reverts to the stale title
 * once the optimistic overlay clears.
 */
function applyTitleToSessionCaches(
  mutate: SessionCacheMutator,
  sessionId: string,
  title: string | null
): Promise<unknown> {
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

function revalidateSessionCaches(mutate: SessionCacheMutator) {
  void mutate(isSessionListKey).catch(() => undefined);
  void mutate(isSessionInboxKey).catch(() => undefined);
}

interface RenameOwner {
  latestRequestId: number;
  confirmedTitle?: string | null;
  optimisticTitle?: string;
  queue: Promise<void>;
  pendingRequests: number;
  authoritativeSubscribers: number;
  listeners: Set<() => void>;
}

const renameOwners = new Map<string, RenameOwner>();

function getRenameOwner(sessionId: string): RenameOwner {
  let owner = renameOwners.get(sessionId);
  if (!owner) {
    owner = {
      latestRequestId: 0,
      queue: Promise.resolve(),
      pendingRequests: 0,
      authoritativeSubscribers: 0,
      listeners: new Set(),
    };
    renameOwners.set(sessionId, owner);
  }
  return owner;
}

function deleteIdleOwner(sessionId: string, owner: RenameOwner) {
  if (
    owner.listeners.size === 0 &&
    owner.pendingRequests === 0 &&
    owner.authoritativeSubscribers === 0
  ) {
    renameOwners.delete(sessionId);
  }
}

function publishOptimisticTitle(owner: RenameOwner, title: string | undefined) {
  owner.optimisticTitle = title;
  owner.listeners.forEach((listener) => listener());
}

interface UseSessionRenameOptions {
  sessionId: string;
  currentTitle: string | null;
  authoritativeTitle?: string | null;
  awaitAuthoritativeTitle?: boolean;
}

export function useSessionRename({
  sessionId,
  currentTitle,
  authoritativeTitle,
  awaitAuthoritativeTitle = false,
}: UseSessionRenameOptions) {
  const { mutate } = useSWRConfig();
  const currentTitleRef = useRef(currentTitle);
  const authoritativeTitleRef = useRef(authoritativeTitle);

  useLayoutEffect(() => {
    currentTitleRef.current = currentTitle;
    authoritativeTitleRef.current = authoritativeTitle;
  }, [authoritativeTitle, currentTitle]);

  const subscribe = useCallback(
    (listener: () => void) => {
      const owner = getRenameOwner(sessionId);
      owner.listeners.add(listener);
      return () => {
        owner.listeners.delete(listener);
        deleteIdleOwner(sessionId, owner);
      };
    },
    [sessionId]
  );
  const getSnapshot = useCallback(() => getRenameOwner(sessionId).optimisticTitle, [sessionId]);
  const optimisticTitle = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const owner = getRenameOwner(sessionId);
    if (awaitAuthoritativeTitle) {
      owner.authoritativeSubscribers += 1;
    }

    if (authoritativeTitle !== undefined) {
      if (owner.pendingRequests === 0) {
        owner.confirmedTitle = authoritativeTitle;
      }
      if (authoritativeTitle === owner.optimisticTitle && owner.pendingRequests === 0) {
        void applyTitleToSessionCaches(mutate, sessionId, authoritativeTitle)
          .catch(() => undefined)
          .then(() => {
            if (owner.pendingRequests === 0 && owner.optimisticTitle === authoritativeTitle) {
              publishOptimisticTitle(owner, undefined);
            }
          });
      }
    }

    return () => {
      if (awaitAuthoritativeTitle) {
        owner.authoritativeSubscribers -= 1;
      }
      deleteIdleOwner(sessionId, owner);
    };
  }, [authoritativeTitle, awaitAuthoritativeTitle, mutate, sessionId]);

  const renameSession = useCallback(
    (title: string): Promise<boolean> => {
      const owner = getRenameOwner(sessionId);
      const requestId = ++owner.latestRequestId;
      if (owner.pendingRequests === 0) {
        owner.confirmedTitle = currentTitleRef.current;
      }
      owner.pendingRequests += 1;

      publishOptimisticTitle(owner, title);
      const optimisticUpdate = applyTitleToSessionCaches(mutate, sessionId, title);

      const request = owner.queue.then(async () => {
        await optimisticUpdate.catch(() => undefined);
        const response = await browserApiFetch(`/api/sessions/${sessionId}/title`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });

        if (!response.ok) {
          throw new Error("Failed to update session title");
        }

        owner.confirmedTitle = title;
      });

      owner.queue = request.then(
        () => undefined,
        () => undefined
      );

      return request.then(
        async () => {
          owner.pendingRequests -= 1;
          if (owner.latestRequestId === requestId) {
            await applyTitleToSessionCaches(mutate, sessionId, title).catch(() => undefined);
            if (owner.authoritativeSubscribers === 0 || authoritativeTitleRef.current === title) {
              publishOptimisticTitle(owner, undefined);
            }
            revalidateSessionCaches(mutate);
          }
          deleteIdleOwner(sessionId, owner);
          return true;
        },
        async () => {
          owner.pendingRequests -= 1;
          if (owner.latestRequestId !== requestId) {
            deleteIdleOwner(sessionId, owner);
            return true;
          }

          if (authoritativeTitleRef.current === title) {
            owner.confirmedTitle = title;
            await applyTitleToSessionCaches(mutate, sessionId, title).catch(() => undefined);
            publishOptimisticTitle(owner, undefined);
            revalidateSessionCaches(mutate);
            deleteIdleOwner(sessionId, owner);
            return true;
          }

          publishOptimisticTitle(
            owner,
            owner.confirmedTitle === currentTitleRef.current
              ? undefined
              : (owner.confirmedTitle ?? undefined)
          );
          await applyTitleToSessionCaches(mutate, sessionId, owner.confirmedTitle ?? null).catch(
            () => undefined
          );
          if (owner.authoritativeSubscribers === 0) {
            publishOptimisticTitle(owner, undefined);
          }
          deleteIdleOwner(sessionId, owner);
          return false;
        }
      );
    },
    [mutate, sessionId]
  );

  return { optimisticTitle, renameSession };
}
