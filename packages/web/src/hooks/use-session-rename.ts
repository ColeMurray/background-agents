"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { applySessionTitleToCaches } from "@/lib/session-title-cache";
import {
  getSessionTitleRevision,
  reconcileSessionTitleRevision,
} from "@/lib/session-title-reconciliation";

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
  authoritativeUpdatedAt?: number;
  awaitAuthoritativeTitle?: boolean;
}

export function useSessionRename({
  sessionId,
  currentTitle,
  authoritativeTitle,
  authoritativeUpdatedAt,
  awaitAuthoritativeTitle = false,
}: UseSessionRenameOptions) {
  const { cache, mutate } = useSWRConfig();
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
      if (authoritativeUpdatedAt !== undefined) {
        reconcileSessionTitleRevision({
          sessionId,
          title: authoritativeTitle,
          updatedAt: authoritativeUpdatedAt,
        });
      }
      if (owner.pendingRequests === 0) {
        owner.confirmedTitle = authoritativeTitle;
      }
      if (authoritativeTitle === owner.optimisticTitle && owner.pendingRequests === 0) {
        void applySessionTitleToCaches(mutate, cache, sessionId, authoritativeTitle)
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
  }, [
    authoritativeTitle,
    authoritativeUpdatedAt,
    awaitAuthoritativeTitle,
    cache,
    mutate,
    sessionId,
  ]);

  const renameSession = useCallback(
    (title: string): Promise<boolean> => {
      const owner = getRenameOwner(sessionId);
      const requestId = ++owner.latestRequestId;
      const authoritativeRevisionAtStart = getSessionTitleRevision(sessionId)?.updatedAt;
      if (owner.pendingRequests === 0) {
        owner.confirmedTitle = currentTitleRef.current;
      }
      owner.pendingRequests += 1;

      publishOptimisticTitle(owner, title);
      const optimisticUpdate = applySessionTitleToCaches(mutate, cache, sessionId, title);

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

        const payload: unknown = await response.json();
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof (payload as { title?: unknown }).title !== "string" ||
          typeof (payload as { updatedAt?: unknown }).updatedAt !== "number"
        ) {
          throw new Error("Invalid session title response");
        }
        const latest = reconcileSessionTitleRevision({
          sessionId,
          title: (payload as { title: string }).title,
          updatedAt: (payload as { updatedAt: number }).updatedAt,
        });
        owner.confirmedTitle = latest.title;
      });

      owner.queue = request.then(
        () => undefined,
        () => undefined
      );

      return request.then(
        async () => {
          owner.pendingRequests -= 1;
          if (owner.latestRequestId === requestId) {
            const latest = getSessionTitleRevision(sessionId);
            const confirmedTitle = latest?.title ?? title;
            await applySessionTitleToCaches(
              mutate,
              cache,
              sessionId,
              confirmedTitle,
              latest?.updatedAt
            ).catch(() => undefined);
            publishOptimisticTitle(owner, undefined);
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

          const latest = getSessionTitleRevision(sessionId);
          if (
            latest &&
            (authoritativeRevisionAtStart === undefined ||
              latest.updatedAt > authoritativeRevisionAtStart)
          ) {
            owner.confirmedTitle = latest.title;
            await applySessionTitleToCaches(
              mutate,
              cache,
              sessionId,
              latest.title,
              latest.updatedAt
            ).catch(() => undefined);
            publishOptimisticTitle(owner, undefined);
            deleteIdleOwner(sessionId, owner);
            return latest.title === title;
          }

          if (authoritativeTitleRef.current === title) {
            owner.confirmedTitle = title;
            await applySessionTitleToCaches(mutate, cache, sessionId, title).catch(() => undefined);
            publishOptimisticTitle(owner, undefined);
            deleteIdleOwner(sessionId, owner);
            return true;
          }

          publishOptimisticTitle(
            owner,
            owner.confirmedTitle === currentTitleRef.current
              ? undefined
              : (owner.confirmedTitle ?? undefined)
          );
          await applySessionTitleToCaches(
            mutate,
            cache,
            sessionId,
            owner.confirmedTitle ?? null
          ).catch(() => undefined);
          if (owner.authoritativeSubscribers === 0) {
            publishOptimisticTitle(owner, undefined);
          }
          deleteIdleOwner(sessionId, owner);
          return false;
        }
      );
    },
    [cache, mutate, sessionId]
  );

  return { optimisticTitle, renameSession };
}
