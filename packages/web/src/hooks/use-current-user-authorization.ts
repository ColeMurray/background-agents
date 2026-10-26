"use client";

import useSWR, { useSWRConfig, type Cache } from "swr";
import {
  effectiveAuthorizationSchema,
  type EffectiveAuthorization,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useCallback, useEffect } from "react";

/** Endpoint key for the signed-in user's effective workspace authorization. */
const CURRENT_USER_AUTHORIZATION_KEY = "/api/me/authorization" as const;
const pendingAuthorization = new WeakMap<Cache, Promise<EffectiveAuthorization>>();

/** Returns the user-scoped cache key for effective workspace authorization. */
export function currentUserAuthorizationKey(userId: string) {
  return [CURRENT_USER_AUTHORIZATION_KEY, userId] as const;
}

/**
 * A failed authorization lookup, classified by whether the grant it failed to
 * refresh may still be trusted. Retryable failures leave the request unanswered;
 * every other failure is an answer, and a denial answer must take effect.
 */
class AuthorizationRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "AuthorizationRequestError";
  }
}

/** Whether a cached grant survives `error`; an unrecognized failure never does. */
function retainsCachedAuthorization(error: unknown): boolean {
  return error instanceof AuthorizationRequestError && error.retryable;
}

async function fetchAuthorization(): Promise<EffectiveAuthorization> {
  let response: Response;
  try {
    response = await browserApiFetch(CURRENT_USER_AUTHORIZATION_KEY);
  } catch (cause) {
    // The request never reached the server, so it denies nothing.
    throw new AuthorizationRequestError(`Authorization request failed (${String(cause)})`, true);
  }
  if (!response.ok) {
    throw new AuthorizationRequestError(
      `Authorization request failed (${response.status})`,
      response.status >= 500
    );
  }
  return effectiveAuthorizationSchema.parse(await response.json());
}

function prefetchCurrentUserAuthorization(cache: Cache): void {
  if (pendingAuthorization.has(cache)) return;
  const pending = fetchAuthorization();
  pendingAuthorization.set(cache, pending);
  void pending.catch(() => {});
}

async function fetchAuthorizationFor(
  userId: string,
  cache: Cache
): Promise<EffectiveAuthorization> {
  const pending = pendingAuthorization.get(cache);
  pendingAuthorization.delete(cache);
  if (pending) {
    try {
      const authorization = await pending;
      if (authorization.userId === userId) return authorization;
    } catch {
      // A speculative failure must not decide the authenticated user's access.
    }
  }

  const authorization = await fetchAuthorization();
  if (authorization.userId !== userId) {
    throw new AuthorizationRequestError("Authorization belongs to another user", false);
  }
  return authorization;
}

/**
 * Provides the signed-in user's effective permissions, denying permission checks until they load.
 */
export function useCurrentUserAuthorization(): {
  authorization: EffectiveAuthorization | null;
  loading: boolean;
  error: unknown;
  hasPermission: (permission: PermissionId) => boolean;
} {
  const { data: session, status } = useAuthSession();
  const userId = session?.user?.id;
  const { cache } = useSWRConfig();
  useEffect(() => {
    if (status === "loading") prefetchCurrentUserAuthorization(cache);
  }, [status, cache]);
  const { data, isLoading, error } = useSWR(
    status === "authenticated" && userId ? currentUserAuthorizationKey(userId) : null,
    ([, userId]) => fetchAuthorizationFor(userId, cache)
  );
  // A revalidation that failed without denying anything leaves the last grant in
  // force; anything else withholds it, so a revoked role stops granting access.
  const authorization =
    error === undefined || retainsCachedAuthorization(error) ? (data ?? null) : null;
  const hasPermission = useCallback(
    (permission: PermissionId) => authorization?.permissions.includes(permission) ?? false,
    [authorization]
  );

  return {
    authorization,
    loading: status === "authenticated" && isLoading,
    error,
    hasPermission,
  };
}
