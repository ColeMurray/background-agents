import { z } from "zod";
import { fetchProvider, parseProviderResponse, readBoundedProviderBody } from "./provider-response";

const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 365 * 24 * 60 * 60;

const tokenFields = {
  access_token: z.string().min(1).max(65_536),
  expires_in: z.number().int().positive().max(MAX_TOKEN_LIFETIME_SECONDS).optional(),
  expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  refresh_token_expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  refresh_token_expires_in: z.number().int().positive().max(MAX_TOKEN_LIFETIME_SECONDS).optional(),
  scope: z.string().trim().min(1).max(4096).optional(),
  token_type: z.string().trim().min(1).max(32).optional(),
} as const;

export const anthropicInitialTokenResponseSchema = z.object({
  ...tokenFields,
  refresh_token: z.string().min(1).max(65_536),
});

export const anthropicRefreshTokenResponseSchema = z.object({
  ...tokenFields,
  refresh_token: z.string().min(1).max(65_536).optional(),
});

export type AnthropicInitialTokenResponse = z.infer<typeof anthropicInitialTokenResponseSchema>;
export type AnthropicRefreshTokenResponse = z.infer<typeof anthropicRefreshTokenResponseSchema>;
export type AnthropicTokenErrorReason = "unauthorized" | "invalid_response" | "other";

export class AnthropicTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: AnthropicTokenErrorReason
  ) {
    super(message);
  }
}

function classifyError(status: number, body: string): AnthropicTokenErrorReason {
  try {
    const parsed = z.object({ error: z.literal("invalid_grant") }).safeParse(JSON.parse(body));
    if (parsed.success) return "unauthorized";
  } catch {
    // Provider error bodies are intentionally discarded.
  }
  return status === 401 ? "unauthorized" : "other";
}

async function parseTokenResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    const body = await readBoundedProviderBody(
      response,
      () =>
        new AnthropicTokenError(
          "Anthropic token request returned an oversized response",
          502,
          "invalid_response"
        )
    );
    throw new AnthropicTokenError(
      `Anthropic token request failed: ${response.status}`,
      response.status,
      classifyError(response.status, body)
    );
  }
  return parseProviderResponse(
    response,
    schema,
    (_reason, status) =>
      new AnthropicTokenError(
        `Anthropic token request returned an invalid response: ${status}`,
        status,
        "invalid_response"
      )
  );
}

export async function exchangeAnthropicAuthorizationCode(input: {
  authorizationCode: string;
  codeVerifier: string;
  state: string;
}): Promise<AnthropicInitialTokenResponse> {
  const response = await fetchProvider(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      code: input.authorizationCode,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: input.codeVerifier,
      state: input.state,
    }),
  });
  return parseTokenResponse(response, anthropicInitialTokenResponseSchema);
}

export async function refreshAnthropicToken(
  refreshToken: string
): Promise<AnthropicRefreshTokenResponse> {
  const response = await fetchProvider(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: ANTHROPIC_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  return parseTokenResponse(response, anthropicRefreshTokenResponseSchema);
}
