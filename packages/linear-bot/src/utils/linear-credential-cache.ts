import type { Env } from "../types";
import {
  storedLinearClientCredentialsTokenSchema,
  type StoredLinearClientCredentialsToken,
} from "./linear-credential-schemas";
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
  const parsed = storedLinearClientCredentialsTokenSchema.safeParse(value);
  if (!parsed.success) return null;

  const token = parsed.data;
  if (
    !hasCanonicalLinearScope(token.scope) ||
    token.expires_at <= token.issued_at ||
    token.organization_id !== organizationId ||
    (expectedAppUserId !== undefined && token.app_user_id !== expectedAppUserId)
  ) {
    return null;
  }
  return token;
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
