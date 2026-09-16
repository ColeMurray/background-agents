"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { isSessionListKey } from "@/lib/session-list";
import { isSessionInboxKey } from "@/lib/session-inbox-api";

type SessionCacheMutator = ReturnType<typeof useSWRConfig>["mutate"];

function revalidateSessionCaches(mutate: SessionCacheMutator): void {
  void mutate(isSessionListKey).catch(() => undefined);
  void mutate(isSessionInboxKey).catch(() => undefined);
}

interface RenameOwner {
  latestRequestId: number;
  confirmedTitle?: string | null;
  optimisticTitle?: string;
  authoritativeTitle?: string | null;
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
  if (owner.pendingRequests === 0 && owner.authoritativeSubscribers === 0) {
    owner.authoritativeTitle = undefined;
    if (owner.listeners.size === 0) {
      renameOwners.delete(sessionId);
    }
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

  useLayoutEffect(() => {
    currentTitleRef.current = currentTitle;
    if (authoritativeTitle !== undefined) {
      getRenameOwner(sessionId).authoritativeTitle = authoritativeTitle;
    }
  }, [authoritativeTitle, currentTitle, sessionId]);

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
      owner.authoritativeTitle = authoritativeTitle;
      if (owner.pendingRequests === 0) {
        owner.confirmedTitle = authoritativeTitle;
      }
      // The next authoritative title wins even if its HTTP response is still pending.
      if (owner.optimisticTitle !== undefined) {
        publishOptimisticTitle(owner, undefined);
      }
    }

    return () => {
      if (awaitAuthoritativeTitle) {
        owner.authoritativeSubscribers -= 1;
        if (owner.authoritativeSubscribers === 0 && owner.pendingRequests === 0) {
          publishOptimisticTitle(owner, undefined);
        }
      }
      deleteIdleOwner(sessionId, owner);
    };
  }, [authoritativeTitle, awaitAuthoritativeTitle, sessionId]);

  const renameSession = useCallback(
    (title: string): Promise<boolean> => {
      const owner = getRenameOwner(sessionId);
      const requestId = ++owner.latestRequestId;
      if (owner.pendingRequests === 0) {
        owner.confirmedTitle = currentTitleRef.current;
      }
      owner.pendingRequests += 1;

      publishOptimisticTitle(owner, title);

      const request = owner.queue.then(async () => {
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
        () => {
          owner.pendingRequests -= 1;
          if (owner.latestRequestId === requestId) {
            if (owner.authoritativeSubscribers === 0 || owner.authoritativeTitle === title) {
              publishOptimisticTitle(owner, undefined);
            }
            revalidateSessionCaches(mutate);
          }
          deleteIdleOwner(sessionId, owner);
          return true;
        },
        () => {
          owner.pendingRequests -= 1;
          if (owner.latestRequestId !== requestId) {
            deleteIdleOwner(sessionId, owner);
            return true;
          }

          const confirmedByAuthority = owner.authoritativeTitle === title;
          if (confirmedByAuthority || owner.optimisticTitle === undefined) {
            if (confirmedByAuthority) owner.confirmedTitle = title;
            publishOptimisticTitle(owner, undefined);
            revalidateSessionCaches(mutate);
            deleteIdleOwner(sessionId, owner);
            return confirmedByAuthority;
          }

          publishOptimisticTitle(
            owner,
            owner.confirmedTitle === currentTitleRef.current
              ? undefined
              : (owner.confirmedTitle ?? undefined)
          );
          revalidateSessionCaches(mutate);
          if (
            owner.authoritativeSubscribers === 0 ||
            owner.authoritativeTitle === owner.confirmedTitle
          ) {
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
