/**
 * GitHub authentication utilities.
 */

import { DEFAULT_APP_NAME } from "@open-inspect/shared";
import { z } from "zod";
import { decryptToken, encryptToken } from "./crypto";
import { githubTokenResponseSchema, type GitHubUser, type GitHubTokenResponse } from "../types";

const githubOAuthErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

async function parseGitHubTokenResponse(response: Response): Promise<GitHubTokenResponse> {
  const data: unknown = await response.json();
  const errorResult = githubOAuthErrorSchema.safeParse(data);
  if (errorResult.success && errorResult.data.error) {
    throw new Error(errorResult.data.error_description ?? errorResult.data.error);
  }

  const tokenResult = githubTokenResponseSchema.safeParse(data);
  if (!tokenResult.success) {
    throw new Error("Invalid GitHub token response");
  }

  return tokenResult.data;
}

/**
 * GitHub OAuth configuration.
 */
export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
}

/**
 * GitHub token with metadata.
 */
export interface StoredGitHubToken {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: number | null;
  scope: string;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForToken(
  code: string,
  config: GitHubOAuthConfig
): Promise<GitHubTokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
  });

  return parseGitHubTokenResponse(response);
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  config: GitHubOAuthConfig
): Promise<GitHubTokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  return parseGitHubTokenResponse(response);
}

/**
 * Get current user info from GitHub.
 */
export async function getGitHubUser(
  accessToken: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": userAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  return response.json() as Promise<GitHubUser>;
}

/**
 * Get user's email addresses from GitHub.
 */
export async function getGitHubUserEmails(
  accessToken: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<Array<{ email: string; primary: boolean; verified: boolean }>> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": userAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  return response.json() as Promise<Array<{ email: string; primary: boolean; verified: boolean }>>;
}

/**
 * Store encrypted GitHub tokens.
 */
export async function encryptGitHubTokens(
  tokens: GitHubTokenResponse,
  encryptionKey: string
): Promise<StoredGitHubToken> {
  const accessTokenEncrypted = await encryptToken(tokens.access_token, encryptionKey);

  const refreshTokenEncrypted = tokens.refresh_token
    ? await encryptToken(tokens.refresh_token, encryptionKey)
    : null;

  const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null;

  return {
    accessTokenEncrypted,
    refreshTokenEncrypted,
    expiresAt,
    scope: tokens.scope,
  };
}

/**
 * Get valid access token, refreshing if necessary.
 */
export async function getValidAccessToken(
  stored: StoredGitHubToken,
  config: GitHubOAuthConfig
): Promise<{ accessToken: string; refreshed: boolean; newStored?: StoredGitHubToken }> {
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000; // 5 minutes

  // Check if token needs refresh
  if (stored.expiresAt && stored.expiresAt - now < bufferMs) {
    if (!stored.refreshTokenEncrypted) {
      throw new Error("Token expired and no refresh token available");
    }

    const refreshToken = await decryptToken(stored.refreshTokenEncrypted, config.encryptionKey);

    const newTokens = await refreshAccessToken(refreshToken, config);
    const newStored = await encryptGitHubTokens(newTokens, config.encryptionKey);

    return {
      accessToken: newTokens.access_token,
      refreshed: true,
      newStored,
    };
  }

  // Token is still valid
  const accessToken = await decryptToken(stored.accessTokenEncrypted, config.encryptionKey);

  return {
    accessToken,
    refreshed: false,
  };
}

/**
 * Generate noreply email for users with private email.
 */
export function generateNoreplyEmail(githubUser: GitHubUser): string {
  return `${githubUser.id}+${githubUser.login}@users.noreply.github.com`;
}

/**
 * Get best email for git commit attribution.
 */
export function getCommitEmail(
  githubUser: GitHubUser,
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>
): string {
  // Use public email if available
  if (githubUser.email) {
    return githubUser.email;
  }

  // Use primary verified email from list
  if (emails) {
    const primary = emails.find((e) => e.primary && e.verified);
    if (primary) {
      return primary.email;
    }
  }

  // Fall back to noreply
  return generateNoreplyEmail(githubUser);
}
