/**
 * OpenAI OAuth token refresh utilities.
 */

import { z } from "zod";
import {
  fetchProvider,
  parseProviderResponse,
  readBoundedProviderBody,
  type ProviderResponseErrorFactory,
} from "./provider-response";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_DEVICE_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const OPENAI_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const OPENAI_DEVICE_REDIRECT_URL = "https://auth.openai.com/deviceauth/callback";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_OPENAI_TOKEN_LIFETIME_SECONDS = 60 * 60;
const MAX_OPENAI_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

const tokenLifetimeSchema = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().positive());

const openAITokenResponseSchema = z.object({
  id_token: z.string().min(1).max(16_384).optional(),
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384),
  expires_in: tokenLifetimeSchema.optional(),
});

const deviceAuthorizationSchema = z.object({
  device_auth_id: z.string().min(1).max(4096),
  user_code: z.string().min(1).max(128),
  interval: z
    .union([z.number().int(), z.string().regex(/^\d+$/)])
    .transform(Number)
    .pipe(z.number().int().min(1).max(60)),
});

const deviceStatusSchema = z.object({
  authorization_code: z.string().min(1).max(4096),
  code_verifier: z.string().min(1).max(4096),
});

const openAIAccountIdSchema = z.string().trim().min(1);
const openAIIdentityClaimsSchema = z.object({
  chatgpt_account_id: openAIAccountIdSchema.optional(),
  "https://api.openai.com/auth": z
    .object({ chatgpt_account_id: openAIAccountIdSchema.optional() })
    .optional(),
  organizations: z.array(z.object({ id: openAIAccountIdSchema })).optional(),
});

export type OpenAITokenResponse = z.infer<typeof openAITokenResponseSchema>;
export type OpenAIDeviceAuthorization = {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
};
export type OpenAIDeviceStatus =
  | { status: "pending" }
  | { status: "authorized"; authorizationCode: string; codeVerifier: string };

export class OpenAITokenRefreshError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode?: string
  ) {
    super(message);
  }
}

export class OpenAIOAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export function openAIAccessTokenLifetimeMs(expiresIn?: number): number {
  return (
    Math.min(
      expiresIn ?? DEFAULT_OPENAI_TOKEN_LIFETIME_SECONDS,
      MAX_OPENAI_TOKEN_LIFETIME_SECONDS
    ) * 1000
  );
}

function openAIResponseError(operation: string): ProviderResponseErrorFactory {
  return (reason, status, invalidFields) => {
    if (reason === "oversized") {
      return new OpenAIOAuthError(`OpenAI ${operation} returned an oversized response`, 502);
    }
    if (reason === "http") {
      return new OpenAIOAuthError(`OpenAI ${operation} failed`, status);
    }
    if (reason === "invalid_json") {
      return new OpenAIOAuthError(`OpenAI ${operation} returned invalid JSON`, 502);
    }
    return new OpenAIOAuthError(
      `OpenAI ${operation} returned invalid data (${invalidFields?.join(", ")})`,
      502
    );
  };
}

export async function startOpenAIDeviceAuthorization(): Promise<OpenAIDeviceAuthorization> {
  const response = await fetchProvider(OPENAI_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Open-Inspect" },
    body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
  });
  const data = await parseProviderResponse(
    response,
    deviceAuthorizationSchema,
    openAIResponseError("device authorization")
  );
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    intervalMs: data.interval * 1000,
  };
}

export async function checkOpenAIDeviceAuthorization(
  deviceAuthId: string,
  userCode: string
): Promise<OpenAIDeviceStatus> {
  const response = await fetchProvider(OPENAI_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Open-Inspect" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });
  if (response.status === 403 || response.status === 404) {
    await readBoundedProviderBody(response, () =>
      openAIResponseError("device status check")("oversized", response.status)
    );
    return { status: "pending" };
  }
  const data = await parseProviderResponse(
    response,
    deviceStatusSchema,
    openAIResponseError("device status check")
  );
  return {
    status: "authorized",
    authorizationCode: data.authorization_code,
    codeVerifier: data.code_verifier,
  };
}

export async function exchangeOpenAIAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string
): Promise<OpenAITokenResponse> {
  const response = await fetchProvider(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: OPENAI_DEVICE_REDIRECT_URL,
      client_id: OPENAI_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  return parseProviderResponse(
    response,
    openAITokenResponseSchema,
    openAIResponseError("token exchange")
  );
}

/**
 * Refresh an OpenAI OAuth access token using a refresh token.
 */
export async function refreshOpenAIToken(refreshToken: string): Promise<OpenAITokenResponse> {
  const response = await fetchProvider(OPENAI_TOKEN_URL, {
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
    const body = await readBoundedProviderBody(
      response,
      () => new OpenAITokenRefreshError("OpenAI token refresh returned an oversized response", 502)
    );
    let errorCode: string | undefined;
    try {
      const parsed = z.object({ error: z.string() }).safeParse(JSON.parse(body));
      if (parsed.success) errorCode = parsed.data.error;
    } catch {
      // Provider error bodies are intentionally discarded.
    }
    throw new OpenAITokenRefreshError(
      `OpenAI token refresh failed: ${response.status}`,
      response.status,
      errorCode
    );
  }

  return parseProviderResponse(
    response,
    openAITokenResponseSchema,
    (_reason, status) =>
      new OpenAITokenRefreshError(
        `OpenAI token refresh returned invalid response: ${status}`,
        status
      )
  );
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
      const parsed = openAIIdentityClaimsSchema.safeParse(
        JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")))
      );
      if (!parsed.success) continue;
      const payload = parsed.data;
      const accountId =
        payload.chatgpt_account_id ??
        payload["https://api.openai.com/auth"]?.chatgpt_account_id ??
        payload.organizations?.[0]?.id;

      if (accountId) return accountId;
    } catch {
      // Malformed token, try next
    }
  }
  return undefined;
}
