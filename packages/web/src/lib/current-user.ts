import { isCanonicalUserId } from "@open-inspect/shared";
import {
  buildAuthIdentity,
  type AuthIdentity,
  type AuthIdentityUser,
} from "@/lib/build-auth-identity";
import { controlPlaneFetch } from "@/lib/control-plane";

export type CurrentUserIdentityInput = AuthIdentityUser;

type ResolveCurrentUserResult =
  | {
      ok: true;
      userId: string;
    }
  | {
      ok: false;
      status: number;
      body: unknown;
    };

const CURRENT_USER_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const currentUserIdCache = new Map<string, { userId: string; expiresAt: number }>();
const pendingCurrentUserIdResolutions = new Map<string, Promise<ResolveCurrentUserResult>>();

function getResponseUserId(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { userId?: unknown }).userId : undefined;
}

export function clearCurrentUserIdCacheForTests() {
  currentUserIdCache.clear();
  pendingCurrentUserIdResolutions.clear();
}

export async function resolveCurrentUserId(
  user: CurrentUserIdentityInput | null | undefined
): Promise<ResolveCurrentUserResult> {
  const identity = buildAuthIdentity(user);
  const authUserId = identity.authUserId;
  if (!authUserId) {
    return {
      ok: false,
      status: 409,
      body: { error: "User id unavailable" },
    };
  }

  // Resolution is provider-scoped (the route path carries the provider), so the
  // cache must be too — the same id under two providers must never alias.
  const cacheKey = `${identity.authProvider}:${authUserId}`;
  const cached = currentUserIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      ok: true,
      userId: cached.userId,
    };
  }

  const pending = pendingCurrentUserIdResolutions.get(cacheKey);
  if (pending) {
    return pending;
  }

  const resolution = resolveCurrentUserIdUncached(identity, authUserId, user, cacheKey).finally(
    () => {
      pendingCurrentUserIdResolutions.delete(cacheKey);
    }
  );
  pendingCurrentUserIdResolutions.set(cacheKey, resolution);
  return resolution;
}

async function resolveCurrentUserIdUncached(
  identity: AuthIdentity,
  authUserId: string,
  user: CurrentUserIdentityInput | null | undefined,
  cacheKey: string
): Promise<ResolveCurrentUserResult> {
  const response = await controlPlaneFetch(
    `/provider-identities/${identity.authProvider}/${encodeURIComponent(authUserId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        providerLogin: user?.login ?? undefined,
        providerEmail: identity.authEmail,
        displayName: identity.authName || user?.login || undefined,
        avatarUrl: identity.authAvatarUrl,
      }),
    }
  );

  const data = await response.json();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body: data,
    };
  }

  const userId = getResponseUserId(data);
  if (!isCanonicalUserId(userId)) {
    return {
      ok: false,
      status: 502,
      body: { error: "Invalid current user response" },
    };
  }

  currentUserIdCache.set(cacheKey, {
    userId,
    expiresAt: Date.now() + CURRENT_USER_ID_CACHE_TTL_MS,
  });

  return {
    ok: true,
    userId,
  };
}
