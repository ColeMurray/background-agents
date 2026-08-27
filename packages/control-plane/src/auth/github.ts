import { z } from "zod";

export const GITHUB_OAUTH_REQUEST_TIMEOUT_MS = 10_000;

const githubOAuthErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const githubTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

export type GitHubTokenResponse = z.infer<typeof githubTokenResponseSchema>;

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

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
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
    signal: AbortSignal.timeout(GITHUB_OAUTH_REQUEST_TIMEOUT_MS),
  });

  return parseGitHubTokenResponse(response);
}
