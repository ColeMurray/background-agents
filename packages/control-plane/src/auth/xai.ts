import { z } from "zod";
import { PROVIDER_TOKEN_REFRESH_TIMEOUT_MS } from "./provider-token-timeouts";

const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_DEVICE_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const XAI_RESPONSE_MAX_BYTES = 64 * 1024;

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

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > XAI_RESPONSE_MAX_BYTES) {
    throw new Error("xAI returned an oversized response");
  }
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > XAI_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new Error("xAI returned an oversized response");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function providerFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TOKEN_REFRESH_TIMEOUT_MS) });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("xAI returned invalid JSON");
  }
}

export async function startXaiDeviceAuthorization(): Promise<XaiDeviceAuthorization> {
  const response = await providerFetch(XAI_DEVICE_CODE_URL, {
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
  const body = await readBoundedBody(response);
  if (!response.ok) throw new Error(`xAI device authorization failed: ${response.status}`);
  const result = xaiDeviceAuthorizationSchema.safeParse(parseJson(body));
  if (!result.success) throw new Error("xAI device authorization returned invalid data");
  return {
    deviceCode: result.data.device_code,
    userCode: result.data.user_code,
    verificationUrl: result.data.verification_uri_complete ?? result.data.verification_uri,
    expiresInMs: result.data.expires_in ? result.data.expires_in * 1000 : undefined,
    intervalMs: (result.data.interval ?? 5) * 1000,
  };
}

export async function checkXaiDeviceAuthorization(
  deviceCode: string,
  intervalMs: number
): Promise<XaiDeviceStatus> {
  const response = await providerFetch(XAI_TOKEN_URL, {
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
  const body = await readBoundedBody(response);
  const parsed = parseJson(body);
  if (response.ok) {
    const tokens = xaiDeviceTokenResponseSchema.safeParse(parsed);
    if (!tokens.success) throw new Error("xAI device token exchange returned invalid data");
    return { status: "connected", tokens: tokens.data };
  }
  const error = xaiOAuthErrorSchema.safeParse(parsed);
  if (!error.success) throw new Error(`xAI device token exchange failed: ${response.status}`);
  if (error.data.error === "authorization_pending") return { status: "pending" };
  if (error.data.error === "slow_down")
    return { status: "pending", intervalMs: Math.min(intervalMs + 5_000, 60_000) };
  if (error.data.error === "access_denied" || error.data.error === "authorization_denied") {
    return { status: "denied" };
  }
  if (error.data.error === "expired_token") return { status: "expired" };
  return { status: "failed" };
}

export async function fetchXaiAccountId(accessToken: string): Promise<string> {
  const response = await providerFetch(XAI_USERINFO_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  const body = await readBoundedBody(response);
  if (!response.ok) throw new Error(`xAI user info request failed: ${response.status}`);
  const result = xaiUserInfoSchema.safeParse(parseJson(body));
  if (!result.success) throw new Error("xAI user info returned invalid data");
  return result.data.sub;
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
  const response = await providerFetch(XAI_TOKEN_URL, {
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
  const body = await readBoundedBody(response);

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
