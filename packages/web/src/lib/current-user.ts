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

  return {
    ok: true,
    userId: data.userId,
  };
}
