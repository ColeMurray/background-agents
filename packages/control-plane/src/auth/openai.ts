/**
 * OpenAI OAuth token refresh utilities.
 */

import { z } from "zod";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const openAITokenResponseSchema = z.object({
  id_token: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number().optional(),
});

export type OpenAITokenResponse = z.infer<typeof openAITokenResponseSchema>;

export class OpenAITokenRefreshError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
  }
}

/**
 * Refresh an OpenAI OAuth access token using a refresh token.
 */
export async function refreshOpenAIToken(refreshToken: string): Promise<OpenAITokenResponse> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new OpenAITokenRefreshError(
      `OpenAI token refresh failed: ${response.status}`,
      response.status,
      body
    );
  }

  const body = await response.text();
  const parsed: unknown = JSON.parse(body);
  const tokenResult = openAITokenResponseSchema.safeParse(parsed);
  if (!tokenResult.success) {
    throw new OpenAITokenRefreshError(
      `OpenAI token refresh returned invalid response: ${response.status}`,
      response.status,
      body
    );
  }

  return tokenResult.data;
}

/**
 * Extract OpenAI account ID from token claims.
 * Tries id_token first, then access_token.
 * Returns undefined if extraction fails.
 */
export function extractOpenAIAccountId(tokens: OpenAITokenResponse): string | undefined {
  for (const tokenField of [tokens.id_token, tokens.access_token] as const) {
    if (!tokenField) continue;
    try {
      const parts = tokenField.split(".");
      if (parts.length < 2) continue;
      // JWTs use base64url encoding; atob() requires standard base64 with padding
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));

      // Try different claim locations
      const accountId =
        payload.chatgpt_account_id ??
        payload["https://api.openai.com/auth"]?.chatgpt_account_id ??
        payload.organizations?.[0]?.id;

      if (accountId) return String(accountId);
    } catch {
      // Malformed token, try next
    }
  }
  return undefined;
}
