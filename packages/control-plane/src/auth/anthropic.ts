/**
 * Anthropic OAuth token management utilities.
 *
 * Handles token refresh and validation for user-specific Anthropic API access.
 * When users connect their Claude account, their API usage is billed to their own account.
 */

import { encryptToken, decryptToken } from "./crypto";

// Anthropic OAuth endpoints
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

// Token refresh buffer - refresh 15 minutes before expiry
const REFRESH_BUFFER_MS = 15 * 60 * 1000;

interface TokenRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface TokenRefreshError {
  error: string;
  error_description?: string;
}

interface RefreshResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  error?: string;
}

/**
 * Check if a token needs to be refreshed.
 *
 * @param expiresAt - Token expiration timestamp in milliseconds
 * @returns true if the token should be refreshed
 */
export function tokenNeedsRefresh(expiresAt: number): boolean {
  return Date.now() >= expiresAt - REFRESH_BUFFER_MS;
}

/**
 * Refresh an Anthropic OAuth token.
 *
 * @param refreshToken - The encrypted refresh token
 * @param clientId - Anthropic OAuth client ID
 * @param encryptionKey - Key for decrypting/encrypting tokens
 * @returns RefreshResult with new tokens or error
 */
export async function refreshAnthropicToken(
  refreshToken: string,
  clientId: string,
  encryptionKey: string
): Promise<RefreshResult> {
  try {
    // Decrypt the refresh token
    const decryptedRefreshToken = await decryptToken(refreshToken, encryptionKey);

    // Request new tokens
    const response = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "open-inspect-control-plane/1.0",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: decryptedRefreshToken,
        client_id: clientId,
      }),
    });

    const data = (await response.json()) as TokenRefreshResponse | TokenRefreshError;

    if (!response.ok || "error" in data) {
      const errorData = data as TokenRefreshError;
      console.error(`[anthropic] Token refresh failed: ${errorData.error}`);
      return {
        success: false,
        error: errorData.error_description || errorData.error,
      };
    }

    const tokenData = data as TokenRefreshResponse;

    // Calculate new expiration time
    const expiresAt = Date.now() + tokenData.expires_in * 1000;

    // Encrypt the new tokens
    const encryptedAccessToken = await encryptToken(tokenData.access_token, encryptionKey);
    const encryptedRefreshToken = tokenData.refresh_token
      ? await encryptToken(tokenData.refresh_token, encryptionKey)
      : refreshToken; // Keep old refresh token if not rotated

    return {
      success: true,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      expiresAt,
    };
  } catch (error) {
    console.error("[anthropic] Token refresh error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get a valid Anthropic access token, refreshing if necessary.
 *
 * @param accessToken - Encrypted access token
 * @param refreshToken - Encrypted refresh token (optional)
 * @param expiresAt - Token expiration timestamp
 * @param clientId - Anthropic OAuth client ID
 * @param encryptionKey - Key for decrypting/encrypting tokens
 * @param onRefresh - Callback to persist refreshed tokens
 * @returns Decrypted access token or null if unavailable
 */
export async function getValidAnthropicToken(
  accessToken: string,
  refreshToken: string | undefined,
  expiresAt: number,
  clientId: string,
  encryptionKey: string,
  onRefresh?: (result: RefreshResult) => Promise<void>
): Promise<string | null> {
  // Check if token needs refresh
  if (tokenNeedsRefresh(expiresAt)) {
    if (!refreshToken) {
      console.log("[anthropic] Token expired and no refresh token available");
      return null;
    }

    console.log("[anthropic] Token expiring soon, attempting refresh");
    const refreshResult = await refreshAnthropicToken(refreshToken, clientId, encryptionKey);

    if (!refreshResult.success) {
      console.error("[anthropic] Token refresh failed:", refreshResult.error);
      return null;
    }

    // Persist the new tokens
    if (onRefresh) {
      await onRefresh(refreshResult);
    }

    // Return the new decrypted access token
    return decryptToken(refreshResult.accessToken!, encryptionKey);
  }

  // Token is still valid, decrypt and return
  return decryptToken(accessToken, encryptionKey);
}
