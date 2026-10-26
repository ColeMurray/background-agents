"use client";

import useSWR from "swr";
import {
  effectiveAuthorizationSchema,
  type EffectiveAuthorization,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useCallback, useEffect, useRef } from "react";

/** Endpoint key for the signed-in user's effective workspace authorization. */
const CURRENT_USER_AUTHORIZATION_KEY = "/api/me/authorization" as const;

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

/** Starts an authorization request before the session names its user. */
function prefetchAuthorization(): Promise<EffectiveAuthorization> {
  const prefetched = fetchAuthorization();
  void prefetched.catch(() => {});
  return prefetched;
}

/** Fetches `userId`'s authorization, adopting `prefetched` only when it names that user. */
async function fetchAuthorizationFor(
  userId: string,
  prefetched: Promise<EffectiveAuthorization> | null
): Promise<EffectiveAuthorization> {
  if (prefetched) {
    try {
      const authorization = await prefetched;
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
  // Only the fetch that SWR starts as this session lookup authenticates may adopt
  // the prefetch: that fetch runs in SWR's layout effect, before this passive
  // effect drops the prefetch. A failed or signed-out lookup drops it as well,
  // and a remounted consumer starts without one.
  const prefetched = useRef<Promise<EffectiveAuthorization> | null>(null);
  useEffect(() => {
    if (status === "loading") prefetched.current ??= prefetchAuthorization();
    else prefetched.current = null;
  }, [status]);
  const { data, isLoading, error } = useSWR(
    status === "authenticated" && userId ? currentUserAuthorizationKey(userId) : null,
    ([, userId]) => {
      const adoptable = prefetched.current;
      prefetched.current = null;
      return fetchAuthorizationFor(userId, adoptable);
    }
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
