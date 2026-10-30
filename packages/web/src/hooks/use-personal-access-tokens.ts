import useSWR from "swr";
import {
  createdPersonalAccessTokenSchema,
  listPersonalAccessTokensResponseSchema,
  type CreatePersonalAccessTokenRequest,
  type CreatedPersonalAccessToken,
  type PersonalAccessToken,
} from "@open-inspect/shared/types/personal-access-tokens";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const PERSONAL_ACCESS_TOKENS_KEY = "/api/personal-access-tokens";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : fallback;
}

async function fetchTokens(): Promise<PersonalAccessToken[]> {
  const response = await browserApiFetch(PERSONAL_ACCESS_TOKENS_KEY);
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to load access tokens"));
  }
  return listPersonalAccessTokensResponseSchema.parse(await response.json()).tokens;
}

/** The signed-in user's personal access tokens. Never holds a token's secret. */
export function usePersonalAccessTokens() {
  const { data: session } = useAuthSession();
  const userId = session?.user?.id;
  const { data, error, isLoading, mutate } = useSWR(
    userId ? [PERSONAL_ACCESS_TOKENS_KEY, userId] : null,
    fetchTokens
  );
  return { tokens: data ?? [], error, loading: isLoading, mutate };
}

/**
 * Issues a token. The response is the only time the secret is available, so it is returned to
 * the caller rather than cached.
 */
export async function issuePersonalAccessToken(
  request: CreatePersonalAccessTokenRequest
): Promise<CreatedPersonalAccessToken> {
  const response = await browserApiFetch(PERSONAL_ACCESS_TOKENS_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to create access token"));
  }
  return createdPersonalAccessTokenSchema.parse(await response.json());
}

export async function revokePersonalAccessToken(id: string): Promise<void> {
  const response = await browserApiFetch(
    `${PERSONAL_ACCESS_TOKENS_KEY}/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to revoke access token"));
  }
}
