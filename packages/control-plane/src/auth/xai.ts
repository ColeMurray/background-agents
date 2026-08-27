import { z } from "zod";
import {
  fetchProvider,
  parseProviderResponse,
  readBoundedProviderBody,
  type ProviderResponseErrorFactory,
} from "./provider-response";

const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_DEVICE_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const xaiTokenResponseSchema = z.object({
  id_token: z.string().min(1).max(16_384).optional(),
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
});

const xaiDeviceTokenResponseSchema = xaiTokenResponseSchema.extend({
  refresh_token: z.string().min(1),
});

const xaiDeviceAuthorizationSchema = z.object({
  device_code: z.string().min(1).max(4096),
  user_code: z.string().min(1).max(128),
  verification_uri: z.url(),
  verification_uri_complete: z.url().optional(),
  expires_in: z.number().int().positive().optional(),
  interval: z.number().int().min(1).max(60).optional(),
});

const xaiOAuthErrorSchema = z.object({ error: z.string().min(1) });
const xaiDeviceTokenExchangeResponseSchema = z.union([
  xaiDeviceTokenResponseSchema,
  xaiOAuthErrorSchema,
]);
const xaiUserInfoSchema = z.object({ sub: z.string().min(1).max(512) });

export type XaiTokenResponse = z.infer<typeof xaiTokenResponseSchema>;
export type XaiDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInMs?: number;
  intervalMs: number;
};
export type XaiDeviceStatus =
  | { status: "pending"; intervalMs?: number }
  | { status: "connected"; tokens: XaiTokenResponse & { refresh_token: string } }
  | { status: "denied" | "expired" | "failed" };

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

function xaiResponseError(operation: string): ProviderResponseErrorFactory {
  return (reason, status, invalidFields) => {
    if (reason === "oversized") return new Error(`xAI ${operation} returned an oversized response`);
    if (reason === "http") return new Error(`xAI ${operation} failed: ${status}`);
    if (reason === "invalid_json") return new Error(`xAI ${operation} returned invalid JSON`);
    const fieldSuffix = invalidFields?.length ? ` (${invalidFields.join(", ")})` : "";
    return new Error(`xAI ${operation} returned invalid data${fieldSuffix}`);
  };
}

export async function startXaiDeviceAuthorization(): Promise<XaiDeviceAuthorization> {
  const response = await fetchProvider(XAI_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Open-Inspect",
    },
    body: new URLSearchParams({
      client_id: XAI_CLIENT_ID,
      scope: XAI_DEVICE_SCOPE,
      referrer: "opencode",
    }).toString(),
  });
  const result = await parseProviderResponse(
    response,
    xaiDeviceAuthorizationSchema,
    xaiResponseError("device authorization")
  );
  return {
    deviceCode: result.device_code,
    userCode: result.user_code,
    verificationUrl: result.verification_uri_complete ?? result.verification_uri,
    expiresInMs: result.expires_in ? result.expires_in * 1000 : undefined,
    intervalMs: (result.interval ?? 5) * 1000,
  };
}

export async function checkXaiDeviceAuthorization(
  deviceCode: string,
  intervalMs: number
): Promise<XaiDeviceStatus> {
  const response = await fetchProvider(XAI_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Open-Inspect",
    },
    body: new URLSearchParams({
      grant_type: XAI_DEVICE_GRANT_TYPE,
      client_id: XAI_CLIENT_ID,
      device_code: deviceCode,
    }).toString(),
  });
  const parsed = await parseProviderResponse(
    response,
    xaiDeviceTokenExchangeResponseSchema,
    xaiResponseError("device token exchange"),
    { acceptErrorStatus: true }
  );
  if (response.ok) {
    if ("error" in parsed) {
      throw xaiResponseError("device token exchange")("invalid_data", response.status);
    }
    return { status: "connected", tokens: parsed };
  }
  if (!("error" in parsed)) {
    throw xaiResponseError("device token exchange")("invalid_data", response.status);
  }
  if (parsed.error === "authorization_pending") return { status: "pending" };
  if (parsed.error === "slow_down")
    return { status: "pending", intervalMs: Math.min(intervalMs + 5_000, 60_000) };
  if (parsed.error === "access_denied" || parsed.error === "authorization_denied") {
    return { status: "denied" };
  }
  if (parsed.error === "expired_token") return { status: "expired" };
  return { status: "failed" };
}

export async function fetchXaiAccountId(accessToken: string): Promise<string> {
  const response = await fetchProvider(XAI_USERINFO_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  const result = await parseProviderResponse(
    response,
    xaiUserInfoSchema,
    xaiResponseError("user info request")
  );
  return result.sub;
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
  const response = await fetchProvider(XAI_TOKEN_URL, {
    method: "POST",
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

  if (!response.ok) {
    const body = await readBoundedProviderBody(
      response,
      () =>
        new XaiTokenRefreshError(
          "xAI token refresh returned an oversized response",
          502,
          "invalid_response"
        )
    );
    throw new XaiTokenRefreshError(
      `xAI token refresh failed: ${response.status}`,
      response.status,
      classifyRefreshError(response.status, body)
    );
  }

  return parseProviderResponse(
    response,
    xaiTokenResponseSchema,
    (_reason, status) =>
      new XaiTokenRefreshError(
        `xAI token refresh returned invalid response: ${status}`,
        status,
        "invalid_response"
      )
  );
}
