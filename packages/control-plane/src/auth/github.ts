/**
 * GitHub authentication utilities.
 */

import { DEFAULT_APP_NAME, formatGitHubNoreplyEmail } from "@open-inspect/shared";
import { z } from "zod";
import { decryptToken, encryptToken } from "./crypto";
import { githubTokenResponseSchema, type GitHubUser, type GitHubTokenResponse } from "../types";

const githubOAuthErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

/**
 * The `/user` fields this service depends on. `id` and `login` are the identity
 * keys and are validated strictly — a malformed 200 (e.g. no `id`) must fail
 * closed rather than mint a subject on the literal string "undefined". Display
 * fields are lenient (absent → null) so a valid-but-partial response still
 * resolves an identity.
 */
const githubUserSchema = z.object({
  id: z.number(),
  login: z.string().min(1),
  name: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  email: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  avatar_url: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
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

/** Error from a GitHub API call, carrying the HTTP status for callers that map it. */
export class GitHubUserApiError extends Error {
  constructor(readonly status: number) {
    super(`GitHub API error: ${status}`);
    this.name = "GitHubUserApiError";
  }
}

/**
 * Get current user info from GitHub.
 *
 * @throws {GitHubUserApiError} on non-2xx responses, with `status` set.
 * @throws {Error} on a 2xx response whose body is not a valid user — fail
 * closed rather than let a malformed identity through.
 */
export async function getGitHubUser(
  accessToken: string,
  userAgent: string = DEFAULT_APP_NAME,
  signal?: AbortSignal
): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": userAgent,
    },
    signal,
  });

  if (!response.ok) {
    throw new GitHubUserApiError(response.status);
  }

  const parsed = githubUserSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error("Malformed GitHub user response");
  }
  return parsed.data;
}

const githubUserEmailsSchema = z.array(
  z.object({
    email: z.string().min(1),
    primary: z.boolean(),
    verified: z.boolean(),
  })
);

/**
 * Get user's email addresses from GitHub.
 *
 * @throws {GitHubUserApiError} on non-2xx responses, with `status` set — most
 * often 403 when the GitHub App is missing the "Email addresses" permission,
 * or 404 when an OAuth token lacks the email scope.
 * @throws {Error} on a 2xx response whose body is not a valid email list —
 * email evidence is an identity-linking key, so a malformed body must fail
 * closed, never read as "no email".
 */
export async function getGitHubUserEmails(
  accessToken: string,
  userAgent: string = DEFAULT_APP_NAME,
  signal?: AbortSignal
): Promise<Array<{ email: string; primary: boolean; verified: boolean }>> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": userAgent,
    },
    signal,
  });

  if (!response.ok) {
    throw new GitHubUserApiError(response.status);
  }

  const parsed = githubUserEmailsSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error("Malformed GitHub user emails response");
  }
  return parsed.data;
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
  return formatGitHubNoreplyEmail(githubUser);
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
