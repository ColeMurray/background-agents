import { decryptToken, encryptToken } from "./crypto";
import type { BitbucketTokenResponse, BitbucketUser } from "../types";

const BITBUCKET_TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token";
const BITBUCKET_API_BASE = "https://api.bitbucket.org/2.0";

export interface BitbucketOAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface BitbucketOAuthConfig extends BitbucketOAuthClientConfig {
  encryptionKey: string;
}

export interface StoredBitbucketToken {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: number | null;
  scopes: string;
}

function createBasicAuth(clientId: string, clientSecret: string): string {
  const credentials = `${clientId}:${clientSecret}`;
  return `Basic ${btoa(credentials)}`;
}

async function readTokenResponse(response: Response): Promise<BitbucketTokenResponse> {
  const data = (await response.json()) as BitbucketTokenResponse & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok || data.error) {
    throw new Error(data.error_description ?? data.error ?? `Bitbucket OAuth error: ${response.status}`);
  }

  return data;
}

export async function exchangeCodeForToken(
  code: string,
  config: BitbucketOAuthClientConfig,
  redirectUri?: string
): Promise<BitbucketTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
  });
  if (redirectUri) {
    body.set("redirect_uri", redirectUri);
  }

  const response = await fetch(BITBUCKET_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: createBasicAuth(config.clientId, config.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  return readTokenResponse(response);
}

export async function refreshAccessToken(
  refreshToken: string,
  config: BitbucketOAuthClientConfig
): Promise<BitbucketTokenResponse> {
  const response = await fetch(BITBUCKET_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: createBasicAuth(config.clientId, config.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  return readTokenResponse(response);
}

export async function getClientCredentialsToken(
  config: BitbucketOAuthClientConfig
): Promise<BitbucketTokenResponse> {
  const response = await fetch(BITBUCKET_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: createBasicAuth(config.clientId, config.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
  });

  return readTokenResponse(response);
}

export async function getBitbucketUser(accessToken: string): Promise<BitbucketUser> {
  const response = await fetch(`${BITBUCKET_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Bitbucket API error: ${response.status}`);
  }

  return response.json() as Promise<BitbucketUser>;
}

export async function getBitbucketUserEmails(
  accessToken: string
): Promise<Array<{ email: string; is_primary: boolean; is_confirmed: boolean }>> {
  const response = await fetch(`${BITBUCKET_API_BASE}/user/emails`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Bitbucket API error: ${response.status}`);
  }

  const payload = (await response.json()) as {
    values?: Array<{ email: string; is_primary: boolean; is_confirmed: boolean }>;
  };
  return payload.values ?? [];
}

export async function encryptBitbucketTokens(
  tokens: BitbucketTokenResponse,
  encryptionKey: string
): Promise<StoredBitbucketToken> {
  const accessTokenEncrypted = await encryptToken(tokens.access_token, encryptionKey);
  const refreshTokenEncrypted = tokens.refresh_token
    ? await encryptToken(tokens.refresh_token, encryptionKey)
    : null;
  const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null;

  return {
    accessTokenEncrypted,
    refreshTokenEncrypted,
    expiresAt,
    scopes: tokens.scopes ?? "",
  };
}

export async function getValidAccessToken(
  stored: StoredBitbucketToken,
  config: BitbucketOAuthConfig
): Promise<{ accessToken: string; refreshed: boolean; newStored?: StoredBitbucketToken }> {
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000;

  if (stored.expiresAt && stored.expiresAt - now < bufferMs) {
    if (!stored.refreshTokenEncrypted) {
      throw new Error("Token expired and no refresh token available");
    }

    const refreshToken = await decryptToken(stored.refreshTokenEncrypted, config.encryptionKey);
    const newTokens = await refreshAccessToken(refreshToken, config);
    const newStored = await encryptBitbucketTokens(newTokens, config.encryptionKey);
    return {
      accessToken: newTokens.access_token,
      refreshed: true,
      newStored,
    };
  }

  const accessToken = await decryptToken(stored.accessTokenEncrypted, config.encryptionKey);
  return { accessToken, refreshed: false };
}

export function getCommitEmail(
  emails?: Array<{ email: string; is_primary: boolean; is_confirmed: boolean }>
): string | null {
  const primary = emails?.find((email) => email.is_primary && email.is_confirmed);
  return primary?.email ?? emails?.find((email) => email.is_confirmed)?.email ?? null;
}
