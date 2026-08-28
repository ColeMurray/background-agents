import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import type {
  AccessToken,
  CreateAccessTokenRequest,
  CreatedAccessToken,
  ListAccessTokensResponse,
} from "@open-inspect/shared/types/access-tokens";

const ACCESS_TOKENS_KEY = "/api/access-tokens";

export function useAccessTokens() {
  const { data: session } = useAuthSession();

  const { data, error, isLoading, mutate } = useSWR<ListAccessTokensResponse>(
    session ? ACCESS_TOKENS_KEY : null
  );

  // `error` is returned rather than swallowed: an empty list and a failed load
  // are different answers, and conflating them tells a user with live tokens
  // that they have none — exactly when they may be trying to revoke one.
  return {
    tokens: data?.tokens ?? ([] as AccessToken[]),
    loading: isLoading,
    error: error as Error | undefined,
    mutate,
  };
}

/**
 * Creates a token. The resolved value carries the only copy of the plaintext
 * the server will ever hand out — show it to the user immediately.
 */
export async function createAccessToken(
  request: CreateAccessTokenRequest
): Promise<CreatedAccessToken> {
  const response = await browserApiFetch(ACCESS_TOKENS_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to create access token");
  }
  return response.json();
}

export async function revokeAccessToken(id: string): Promise<void> {
  const response = await browserApiFetch(`${ACCESS_TOKENS_KEY}/${id}`, { method: "DELETE" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to revoke access token");
  }
}
