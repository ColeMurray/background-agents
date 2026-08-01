import { z } from "zod";

const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export const xaiTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
});

export type XaiTokenResponse = z.infer<typeof xaiTokenResponseSchema>;

type XaiTokenRefreshErrorReason = "invalid_grant" | "unauthorized" | "invalid_response" | "other";

export class XaiTokenRefreshError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reason: XaiTokenRefreshErrorReason
  ) {
    super(message);
  }
}

function classifyRefreshError(status: number, body: string): XaiTokenRefreshErrorReason {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      parsed.error === "invalid_grant"
    ) {
      return "invalid_grant";
    }
  } catch {
    // Error responses are not guaranteed to be JSON.
  }
  return status === 401 ? "unauthorized" : "other";
}

export async function refreshXaiToken(refreshToken: string): Promise<XaiTokenResponse> {
  const response = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(XAI_TOKEN_REQUEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: XAI_CLIENT_ID,
    }).toString(),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new XaiTokenRefreshError(
      `xAI token refresh failed: ${response.status}`,
      response.status,
      classifyRefreshError(response.status, body)
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new XaiTokenRefreshError(
      "xAI token refresh returned invalid JSON",
      response.status,
      "invalid_response"
    );
  }
  const result = xaiTokenResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new XaiTokenRefreshError(
      `xAI token refresh returned invalid response: ${response.status}`,
      response.status,
      "invalid_response"
    );
  }
  return result.data;
}
