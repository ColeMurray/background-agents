"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { applyTitleUpdate, isSessionListKey, type SessionListResponse } from "@/lib/session-list";

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
  currentTitleRef.current = currentTitle;
  authoritativeTitleRef.current = authoritativeTitle;

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
        void mutate<SessionListResponse>(
          isSessionListKey,
          (current) => applyTitleUpdate(current, sessionId, authoritativeTitle),
          { populateCache: true, revalidate: false }
        )
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
      const optimisticUpdate = mutate<SessionListResponse>(
        isSessionListKey,
        (current) => applyTitleUpdate(current, sessionId, title),
        { populateCache: true, revalidate: false }
      );

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
            await mutate<SessionListResponse>(
              isSessionListKey,
              (current) => applyTitleUpdate(current, sessionId, title),
              { populateCache: true, revalidate: false }
            ).catch(() => undefined);
            if (owner.authoritativeSubscribers === 0 || authoritativeTitleRef.current === title) {
              publishOptimisticTitle(owner, undefined);
            }
            void mutate(isSessionListKey).catch(() => undefined);
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
            await mutate<SessionListResponse>(
              isSessionListKey,
              (current) => applyTitleUpdate(current, sessionId, title),
              { populateCache: true, revalidate: false }
            ).catch(() => undefined);
            publishOptimisticTitle(owner, undefined);
            void mutate(isSessionListKey).catch(() => undefined);
            deleteIdleOwner(sessionId, owner);
            return true;
          }

          publishOptimisticTitle(
            owner,
            owner.confirmedTitle === currentTitleRef.current
              ? undefined
              : (owner.confirmedTitle ?? undefined)
          );
          await mutate<SessionListResponse>(
            isSessionListKey,
            (current) => applyTitleUpdate(current, sessionId, owner.confirmedTitle ?? null),
            { populateCache: true, revalidate: false }
          ).catch(() => undefined);
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
