import type {
  Env,
  LinearAuthorizationCodeTokenResponse,
  LinearClientCredentialsTokenResponse,
} from "../types";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

export const LINEAR_CLIENT_CREDENTIALS_SCOPE = "read,write,app:assignable,app:mentionable";
export const LINEAR_TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

const CLIENT_CREDENTIALS_SCOPE_SET = new Set(LINEAR_CLIENT_CREDENTIALS_SCOPE.split(","));

export type LinearAuthFailureReason =
  | "client_credentials_invalid_client"
  | "client_credentials_invalid_scope"
  | "client_credentials_rejected"
  | "client_credentials_error"
  | "client_credentials_malformed_response"
  | "client_credentials_identity_error"
  | "client_credentials_workspace_mismatch"
  | "client_credentials_app_user_mismatch"
  | "client_credentials_rate_limited";

export interface LinearAuthFailure {
  reason: LinearAuthFailureReason;
  status?: number;
  oauthError?: string;
}

export class LinearAuthError extends Error implements LinearAuthFailure {
  readonly reason: LinearAuthFailureReason;
  readonly status?: number;
  readonly oauthError?: string;

  constructor(failure: LinearAuthFailure) {
    super(`Linear auth failed: ${failure.reason}`);
    this.name = "LinearAuthError";
    this.reason = failure.reason;
    this.status = failure.status;
    this.oauthError = failure.oauthError;
  }
}

export class LinearIdentityError extends Error {
  readonly status?: number;

  constructor(status?: number) {
    super("Linear viewer identity could not be verified");
    this.name = "LinearIdentityError";
    this.status = status;
  }
}

export interface LinearIdentity {
  appUserId: string;
  organizationId: string;
  organizationName: string;
}

export interface IssuedClientCredentialsToken {
  accessToken: string;
  issuedAt: number;
  expiresAt: number;
}

function normalizeScope(scope: unknown): string[] | null {
  let values: string[];
  if (typeof scope === "string") {
    values = scope.split(/[\s,]+/);
  } else if (Array.isArray(scope) && scope.every((value) => typeof value === "string")) {
    values = scope;
  } else {
    return null;
  }

  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  return normalized.length > 0 ? normalized : null;
}

export function hasCanonicalLinearScope(scope: unknown): boolean {
  const normalized = normalizeScope(scope);
  return (
    normalized !== null &&
    normalized.length === CLIENT_CREDENTIALS_SCOPE_SET.size &&
    normalized.every((value) => CLIENT_CREDENTIALS_SCOPE_SET.has(value))
  );
}

function parseAuthorizationCodeTokenResponse(value: unknown): LinearAuthorizationCodeTokenResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Linear authorization-code token response was malformed");
  }

  const token = value as Partial<LinearAuthorizationCodeTokenResponse>;
  if (
    typeof token.access_token !== "string" ||
    token.access_token.length === 0 ||
    typeof token.refresh_token !== "string" ||
    token.refresh_token.length === 0 ||
    typeof token.token_type !== "string" ||
    token.token_type.toLowerCase() !== "bearer" ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  ) {
    throw new Error("Linear authorization-code token response was malformed");
  }

  return token as LinearAuthorizationCodeTokenResponse;
}

function parseClientCredentialsTokenResponse(
  value: unknown,
  issuedAt: number
): IssuedClientCredentialsToken {
  if (!value || typeof value !== "object") {
    throw new LinearAuthError({ reason: "client_credentials_malformed_response" });
  }

  const token = value as Partial<LinearClientCredentialsTokenResponse>;
  if (
    typeof token.access_token !== "string" ||
    token.access_token.length === 0 ||
    typeof token.token_type !== "string" ||
    token.token_type.toLowerCase() !== "bearer" ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in * 1000 <= LINEAR_TOKEN_EXPIRY_SKEW_MS
  ) {
    throw new LinearAuthError({ reason: "client_credentials_malformed_response" });
  }
  if (token.scope !== undefined && !hasCanonicalLinearScope(token.scope)) {
    throw new LinearAuthError({ reason: "client_credentials_invalid_scope" });
  }

  const expiresAt = issuedAt + Math.floor(token.expires_in * 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
    throw new LinearAuthError({ reason: "client_credentials_malformed_response" });
  }

  return { accessToken: token.access_token, issuedAt, expiresAt };
}

function parseOAuthErrorCode(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error.slice(0, 100) : undefined;
  } catch {
    return undefined;
  }
}

function classifyTokenEndpointFailure(
  status: number,
  oauthError?: string
): LinearAuthFailureReason {
  if (status === 429) return "client_credentials_rate_limited";
  if (oauthError === "invalid_client") return "client_credentials_invalid_client";
  if (oauthError === "invalid_scope") return "client_credentials_invalid_scope";
  return "client_credentials_rejected";
}

function postTokenRequest(env: Env, body: URLSearchParams): Promise<Response> {
  return fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

export async function exchangeLinearAuthorizationCode(
  env: Env,
  code: string
): Promise<LinearAuthorizationCodeTokenResponse> {
  let response: Response;
  try {
    response = await postTokenRequest(
      env,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        code,
        redirect_uri: `${env.WORKER_URL}/oauth/callback`,
      })
    );
  } catch {
    throw new Error("Linear authorization-code exchange failed");
  }
  if (!response.ok) {
    throw new Error(`Linear authorization-code exchange failed (${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Linear authorization-code token response was malformed");
  }
  return parseAuthorizationCodeTokenResponse(body);
}

export async function issueLinearClientCredentialsToken(
  env: Env
): Promise<IssuedClientCredentialsToken> {
  let response: Response;
  try {
    response = await postTokenRequest(
      env,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        scope: LINEAR_CLIENT_CREDENTIALS_SCOPE,
      })
    );
  } catch {
    throw new LinearAuthError({ reason: "client_credentials_error" });
  }

  if (!response.ok) {
    let oauthError: string | undefined;
    try {
      oauthError = parseOAuthErrorCode(await response.text());
    } catch {
      // The status is sufficient to classify the failure.
    }
    throw new LinearAuthError({
      reason: classifyTokenEndpointFailure(response.status, oauthError),
      status: response.status,
      oauthError,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LinearAuthError({ reason: "client_credentials_malformed_response" });
  }
  return parseClientCredentialsTokenResponse(body, Date.now());
}

export async function fetchLinearIdentity(accessToken: string): Promise<LinearIdentity> {
  try {
    const response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: `query LinearViewerIdentity { viewer { id organization { id name } } }`,
      }),
    });
    if (!response.ok) throw new LinearIdentityError(response.status);

    const payload = (await response.json()) as {
      data?: { viewer?: { id?: string; organization?: { id?: string; name?: string } } };
      errors?: unknown[];
    };
    const viewer = payload.data?.viewer;
    if (
      payload.errors?.length ||
      !viewer ||
      typeof viewer.id !== "string" ||
      viewer.id.length === 0 ||
      typeof viewer.organization?.id !== "string" ||
      viewer.organization.id.length === 0 ||
      typeof viewer.organization.name !== "string" ||
      viewer.organization.name.length === 0
    ) {
      throw new LinearIdentityError();
    }

    return {
      appUserId: viewer.id,
      organizationId: viewer.organization.id,
      organizationName: viewer.organization.name,
    };
  } catch (error) {
    if (error instanceof LinearIdentityError) throw error;
    throw new LinearIdentityError();
  }
}
