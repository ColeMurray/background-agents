import type { Env, StoredLinearClientCredentialsToken } from "../types";
import { hasCanonicalLinearScope, LINEAR_TOKEN_EXPIRY_SKEW_MS } from "./linear-oauth";

const CLIENT_CREDENTIALS_TOKEN_KEY_PREFIX = "oauth:client-credentials:";
const LEGACY_OAUTH_TOKEN_KEY_PREFIX = "oauth:token:";

export type ClientCredentialCacheResult =
  | { status: "hit"; token: StoredLinearClientCredentialsToken }
  | { status: "miss"; reason: "missing" | "invalid" | "expired" };

function clientCredentialsTokenKey(organizationId: string): string {
  return `${CLIENT_CREDENTIALS_TOKEN_KEY_PREFIX}${organizationId}`;
}

function parseCachedToken(
  raw: string,
  organizationId: string,
  expectedAppUserId?: string
): StoredLinearClientCredentialsToken | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const token = value as Partial<StoredLinearClientCredentialsToken>;
  if (
    token.version !== 1 ||
    typeof token.access_token !== "string" ||
    token.access_token.length === 0 ||
    token.token_type !== "Bearer" ||
    !hasCanonicalLinearScope(token.scope) ||
    typeof token.issued_at !== "number" ||
    !Number.isSafeInteger(token.issued_at) ||
    typeof token.expires_at !== "number" ||
    !Number.isSafeInteger(token.expires_at) ||
    token.expires_at <= token.issued_at ||
    token.organization_id !== organizationId ||
    typeof token.organization_name !== "string" ||
    token.organization_name.length === 0 ||
    typeof token.app_user_id !== "string" ||
    token.app_user_id.length === 0 ||
    (expectedAppUserId !== undefined && token.app_user_id !== expectedAppUserId)
  ) {
    return null;
  }

  return token as StoredLinearClientCredentialsToken;
}

export async function readClientCredentialCache(
  env: Env,
  organizationId: string,
  expectedAppUserId?: string
): Promise<ClientCredentialCacheResult> {
  const raw = await env.LINEAR_KV.get(clientCredentialsTokenKey(organizationId));
  if (!raw) return { status: "miss", reason: "missing" };

  const token = parseCachedToken(raw, organizationId, expectedAppUserId);
  if (!token) return { status: "miss", reason: "invalid" };
  if (Date.now() >= token.expires_at - LINEAR_TOKEN_EXPIRY_SKEW_MS) {
    return { status: "miss", reason: "expired" };
  }
  return { status: "hit", token };
}

export async function writeClientCredentialCache(
  env: Env,
  token: StoredLinearClientCredentialsToken
): Promise<void> {
  await env.LINEAR_KV.put(clientCredentialsTokenKey(token.organization_id), JSON.stringify(token), {
    expirationTtl: Math.floor((token.expires_at - token.issued_at) / 1000),
  });
}

export function deleteLegacyOAuthToken(env: Env, organizationId: string): Promise<void> {
  return env.LINEAR_KV.delete(`${LEGACY_OAUTH_TOKEN_KEY_PREFIX}${organizationId}`);
}
