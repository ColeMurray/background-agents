/**
 * Microsoft Bot Framework JWT token validation.
 *
 * Validates the Authorization: Bearer <token> header from Bot Framework
 * against Microsoft's OpenID metadata endpoints using Web Crypto API.
 */

import { createLogger } from "../logger";

const log = createLogger("jwt-validator");

const OPENID_METADATA_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";

const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface JwkKey {
  kty: string;
  kid: string;
  use: string;
  n: string;
  e: string;
  alg?: string;
}

interface OpenIdConfig {
  jwks_uri: string;
  issuer: string;
}

let cachedJwks: { keys: JwkKey[]; issuer: string; fetchedAt: number } | null = null;

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtHeader(token: string): { kid?: string; alg?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
  return header;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  return payload;
}

async function fetchJwks(): Promise<{ keys: JwkKey[]; issuer: string }> {
  if (cachedJwks && Date.now() - cachedJwks.fetchedAt < JWKS_CACHE_TTL_MS) {
    return { keys: cachedJwks.keys, issuer: cachedJwks.issuer };
  }

  const configResponse = await fetch(OPENID_METADATA_URL);
  if (!configResponse.ok) {
    throw new Error(`Failed to fetch OpenID config: ${configResponse.status}`);
  }
  const config = (await configResponse.json()) as OpenIdConfig;

  const jwksResponse = await fetch(config.jwks_uri);
  if (!jwksResponse.ok) {
    throw new Error(`Failed to fetch JWKS: ${jwksResponse.status}`);
  }
  const jwks = (await jwksResponse.json()) as { keys: JwkKey[] };

  cachedJwks = { keys: jwks.keys, issuer: config.issuer, fetchedAt: Date.now() };
  return { keys: jwks.keys, issuer: config.issuer };
}

/**
 * Validate a Bot Framework JWT token.
 *
 * @param authHeader - The Authorization header value
 * @param appId - The Microsoft App ID (audience claim)
 * @returns true if the token is valid
 */
export async function validateBotFrameworkToken(
  authHeader: string | null,
  appId: string
): Promise<boolean> {
  if (!authHeader) return false;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const token = match[1];

  try {
    const header = decodeJwtHeader(token);
    if (!header.kid) return false;

    const { keys, issuer } = await fetchJwks();
    const key = keys.find((k) => k.kid === header.kid);
    if (!key) {
      log.warn("jwt.validation", { outcome: "key_not_found", kid: header.kid });
      return false;
    }

    // Import the RSA public key
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, n: key.n, e: key.e, alg: header.alg || "RS256" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // Verify signature
    const parts = token.split(".");
    const signedContent = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlDecode(parts[2]);

    const isValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signedContent
    );

    if (!isValid) {
      log.warn("jwt.validation", { outcome: "invalid_signature" });
      return false;
    }

    // Validate claims
    const payload = decodeJwtPayload(token);
    const now = Math.floor(Date.now() / 1000);

    // Check expiration
    if (typeof payload.exp === "number" && payload.exp < now) {
      log.warn("jwt.validation", { outcome: "expired" });
      return false;
    }

    // Check not-before
    if (typeof payload.nbf === "number" && payload.nbf > now + 300) {
      log.warn("jwt.validation", { outcome: "not_yet_valid" });
      return false;
    }

    // Check audience matches app ID
    const aud = payload.aud;
    if (aud !== appId) {
      log.warn("jwt.validation", { outcome: "invalid_audience", aud });
      return false;
    }

    // Check issuer — Bot Framework may use different issuers for different channels,
    // so accept any Microsoft-issued token as valid.
    if (typeof payload.iss === "string" && issuer && payload.iss !== issuer) {
      if (!payload.iss.includes("login.microsoftonline.com")) {
        log.warn("jwt.validation", { outcome: "invalid_issuer", iss: payload.iss });
        return false;
      }
    }

    return true;
  } catch (e) {
    log.error("jwt.validation", {
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return false;
  }
}

/** Clear the JWKS cache (for testing). */
export function clearJwksCache(): void {
  cachedJwks = null;
}
