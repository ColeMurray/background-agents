import { isCanonicalUserId } from "@open-inspect/shared";
import { controlPlaneFetch } from "@/lib/control-plane";

export type CurrentUserIdentityInput = {
  id?: string | null;
  login?: string | null;
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

type CurrentUserResponse = {
  userId?: unknown;
};

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

export function clearCurrentUserIdCacheForTests() {
  currentUserIdCache.clear();
  pendingCurrentUserIdResolutions.clear();
}

export async function resolveCurrentUserId(
  user: CurrentUserIdentityInput | null | undefined
): Promise<ResolveCurrentUserResult> {
  if (!user?.id) {
    return {
      ok: false,
      status: 409,
      body: { error: "GitHub user ID is unavailable" },
    };
  }

  const cacheKey = user.id;
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

  const resolution = resolveCurrentUserIdUncached({ ...user, id: cacheKey }).finally(() => {
    pendingCurrentUserIdResolutions.delete(cacheKey);
  });
  pendingCurrentUserIdResolutions.set(cacheKey, resolution);
  return resolution;
}

async function resolveCurrentUserIdUncached(
  user: CurrentUserIdentityInput & { id: string }
): Promise<ResolveCurrentUserResult> {
  const response = await controlPlaneFetch(
    `/provider-identities/github/${encodeURIComponent(user.id)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        providerLogin: user.login,
        providerEmail: user.email,
        displayName: user.name || user.login,
        avatarUrl: user.image,
      }),
    }
  );

  const data = (await response.json()) as CurrentUserResponse;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body: data,
    };
  }

  if (!isCanonicalUserId(data.userId)) {
    return {
      ok: false,
      status: 502,
      body: { error: "Invalid current user response" },
    };
  }

  currentUserIdCache.set(user.id, {
    userId: data.userId,
    expiresAt: Date.now() + CURRENT_USER_ID_CACHE_TTL_MS,
  });

  return {
    ok: true,
    userId: data.userId,
  };
}
