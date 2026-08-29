"use client";

import useSWR from "swr";
import {
  effectiveAuthorizationSchema,
  type EffectiveAuthorization,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export const CURRENT_USER_AUTHORIZATION_KEY = "/api/me/authorization" as const;

export function currentUserAuthorizationKey(userId: string) {
  return [CURRENT_USER_AUTHORIZATION_KEY, userId] as const;
}

async function fetchAuthorization(): Promise<EffectiveAuthorization> {
  const response = await browserApiFetch(CURRENT_USER_AUTHORIZATION_KEY);
  if (!response.ok) throw new Error(`Authorization request failed (${response.status})`);
  return effectiveAuthorizationSchema.parse(await response.json());
}

export function useCurrentUserAuthorization(): {
  authorization: EffectiveAuthorization | null;
  loading: boolean;
  error: unknown;
  hasPermission: (permission: PermissionId) => boolean;
} {
  const { data: session, status } = useAuthSession();
  const userId = session?.user?.id;
  const { data, isLoading, error } = useSWR(
    status === "authenticated" && userId ? currentUserAuthorizationKey(userId) : null,
    fetchAuthorization
  );

  return {
    authorization: data ?? null,
    loading: status === "authenticated" && isLoading,
    error,
    hasPermission: (permission) => data?.permissions.includes(permission) ?? false,
  };
}
