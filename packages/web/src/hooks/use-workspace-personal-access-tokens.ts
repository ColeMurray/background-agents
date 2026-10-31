import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import {
  listWorkspacePersonalAccessTokensResponseSchema,
  personalAccessTokenPolicySnapshotSchema,
  type ListWorkspacePersonalAccessTokensResponse,
  type PersonalAccessTokenPolicy,
  type PersonalAccessTokenPolicySnapshot,
} from "@open-inspect/shared/types/personal-access-tokens";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const POLICY_KEY = "/api/settings/personal-access-token-policy";
const TOKENS_KEY = "/api/settings/personal-access-tokens";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : fallback;
}

async function fetchPolicy(): Promise<PersonalAccessTokenPolicySnapshot> {
  const response = await browserApiFetch(POLICY_KEY);
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to load the access token policy"));
  }
  return personalAccessTokenPolicySnapshotSchema.parse(await response.json());
}

async function fetchTokens(
  url: `/api/${string}`
): Promise<ListWorkspacePersonalAccessTokensResponse> {
  const response = await browserApiFetch(url);
  if (!response.ok) throw new Error(await errorMessage(response, "Failed to load access tokens"));
  return listWorkspacePersonalAccessTokensResponseSchema.parse(await response.json());
}

/** The workspace token policy as administrators edit it. */
export function useWorkspacePersonalAccessTokenPolicy() {
  const { data: session } = useAuthSession();
  const userId = session?.user?.id;
  const { data, error, isLoading, mutate } = useSWR(
    userId ? [POLICY_KEY, userId] : null,
    fetchPolicy
  );
  return { policy: data ?? null, error, loading: isLoading, mutate };
}

/**
 * Every member's tokens, newest first, one page at a time. Each page's key names the signed-in
 * user, so another user signing in on the same browser never sees the cached inventory.
 */
export function useWorkspacePersonalAccessTokens() {
  const { data: session } = useAuthSession();
  const userId = session?.user?.id;
  const { data, error, isLoading, size, setSize, mutate } = useSWRInfinite(
    (
      index: number,
      previous: ListWorkspacePersonalAccessTokensResponse | null
    ): readonly [`/api/${string}`, string] | null => {
      if (!userId) return null;
      if (index === 0) return [TOKENS_KEY, userId];
      if (!previous?.nextCursor) return null;
      return [`${TOKENS_KEY}?cursor=${encodeURIComponent(previous.nextCursor)}`, userId];
    },
    ([url]: readonly [`/api/${string}`, string]) => fetchTokens(url)
  );
  const pages = data ?? [];
  return {
    tokens: pages.flatMap((page) => page.tokens),
    hasMore: pages.length > 0 && pages[pages.length - 1].nextCursor !== null,
    loadMore: () => setSize(size + 1),
    error,
    loading: isLoading,
    mutate,
  };
}

export type SavePersonalAccessTokenPolicyResult =
  | { status: "saved"; policy: PersonalAccessTokenPolicySnapshot }
  /** Someone else changed the policy since `revision`; reload it rather than overwrite theirs. */
  | { status: "conflict" };

/** Replaces the policy if it is still at `revision`. Other refusals throw with their message. */
export async function saveWorkspacePersonalAccessTokenPolicy(
  policy: PersonalAccessTokenPolicy,
  revision: number
): Promise<SavePersonalAccessTokenPolicyResult> {
  const response = await browserApiFetch(POLICY_KEY, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": `"pat-policy-${revision}"` },
    body: JSON.stringify(policy),
  });
  if (response.status === 412) return { status: "conflict" };
  if (!response.ok) throw new Error(await errorMessage(response, "Failed to save the policy"));
  return {
    status: "saved",
    policy: personalAccessTokenPolicySnapshotSchema.parse(await response.json()),
  };
}

export async function revokeWorkspacePersonalAccessToken(id: string): Promise<void> {
  const response = await browserApiFetch(`${TOKENS_KEY}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to revoke access token"));
  }
}

/** Revokes every token a member holds; returns how many were revoked. */
export async function revokeMemberPersonalAccessTokens(userId: string): Promise<number> {
  const response = await browserApiFetch(
    `/api/members/${encodeURIComponent(userId)}/personal-access-tokens`,
    { method: "DELETE" }
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to revoke the member's tokens"));
  }
  const body = (await response.json()) as { revoked?: unknown };
  return typeof body.revoked === "number" ? body.revoked : 0;
}
