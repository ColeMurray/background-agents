/**
 * GitHub authentication utilities.
 */

import { z } from "zod";
import { githubTokenResponseSchema, type GitHubTokenResponse } from "../types";

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
