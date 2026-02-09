/**
 * GitHub App authentication for generating installation tokens.
 *
 * Uses Node.js crypto for RSA-SHA256 signing.
 *
 * Token flow:
 * 1. Generate JWT signed with App's private key
 * 2. Exchange JWT for installation access token via GitHub API
 * 3. Token valid for 1 hour
 */

import crypto from "node:crypto";
import type { InstallationRepository } from "@open-inspect/shared";

/** Timeout for individual GitHub API requests (ms). */
export const GITHUB_FETCH_TIMEOUT_MS = 60_000;

/** Fetch with an AbortController timeout. */
export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = GITHUB_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Per-page timing record returned from listInstallationRepositories. */
export interface GitHubPageTiming {
  page: number;
  fetchMs: number;
  repoCount: number;
}

/** Timing breakdown returned alongside repos from listInstallationRepositories. */
export interface ListReposTiming {
  tokenGenerationMs: number;
  pages: GitHubPageTiming[];
  totalPages: number;
  totalRepos: number;
}

/**
 * Configuration for GitHub App authentication.
 */
export interface GitHubAppConfig {
  appId: string;
  privateKey: string; // PEM format (PKCS#8)
  installationId: string;
}

/**
 * GitHub installation token response.
 */
interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repository_selection?: "all" | "selected";
}

/**
 * Base64URL encode a Buffer or string.
 */
function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/**
 * Generate a JWT for GitHub App authentication using Node.js crypto.
 *
 * @param appId - GitHub App ID
 * @param privateKey - PEM-encoded private key
 * @returns Signed JWT valid for 10 minutes
 */
export async function generateAppJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iat: now - 60, // Issued 60 seconds ago (clock skew tolerance)
    exp: now + 600, // Expires in 10 minutes
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Sign with RSA-SHA256 using Node.js crypto
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(privateKey);

  const encodedSignature = signature.toString("base64url");
  return `${signingInput}.${encodedSignature}`;
}

/**
 * Exchange JWT for an installation access token.
 *
 * @param jwt - Signed JWT
 * @param installationId - GitHub App installation ID
 * @returns Installation access token (valid for 1 hour)
 */
export async function getInstallationToken(jwt: string, installationId: string): Promise<string> {
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Open-Inspect",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${error}`);
  }

  const data = (await response.json()) as InstallationTokenResponse;
  return data.token;
}

/**
 * Generate a fresh GitHub App installation token.
 *
 * @param config - GitHub App configuration
 * @returns Installation access token (valid for 1 hour)
 */
export async function generateInstallationToken(config: GitHubAppConfig): Promise<string> {
  const jwt = await generateAppJwt(config.appId, config.privateKey);
  return getInstallationToken(jwt, config.installationId);
}

// Re-export from shared for backward compatibility
export type { InstallationRepository } from "@open-inspect/shared";

/**
 * GitHub API response for installation repositories.
 */
interface ListInstallationReposResponse {
  total_count: number;
  repository_selection: "all" | "selected";
  repositories: Array<{
    id: number;
    name: string;
    full_name: string;
    description: string | null;
    private: boolean;
    default_branch: string;
    owner: {
      login: string;
    };
  }>;
}

/**
 * List all repositories accessible to the GitHub App installation.
 *
 * Fetches page 1 sequentially to learn total_count, then fetches any
 * remaining pages concurrently.
 */
export async function listInstallationRepositories(
  config: GitHubAppConfig,
): Promise<{ repos: InstallationRepository[]; timing: ListReposTiming }> {
  const tokenStart = performance.now();
  const token = await generateInstallationToken(config);
  const tokenGenerationMs = performance.now() - tokenStart;

  const perPage = 100;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Open-Inspect",
  };

  const fetchPage = async (
    page: number,
  ): Promise<{ data: ListInstallationReposResponse; timing: GitHubPageTiming }> => {
    const url = `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`;
    const pageStart = performance.now();

    const response = await fetchWithTimeout(url, { headers });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to list installation repositories (page ${page}): ${response.status} ${error}`,
      );
    }

    const data = (await response.json()) as ListInstallationReposResponse;
    const fetchMs = Math.round((performance.now() - pageStart) * 100) / 100;

    return { data, timing: { page, fetchMs, repoCount: data.repositories.length } };
  };

  const mapRepos = (data: ListInstallationReposResponse): InstallationRepository[] =>
    data.repositories.map((repo) => ({
      id: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description,
      private: repo.private,
      defaultBranch: repo.default_branch,
    }));

  // Fetch page 1 to learn total_count
  const first = await fetchPage(1);
  const allRepos = mapRepos(first.data);
  const pageTiming: GitHubPageTiming[] = [first.timing];

  const totalCount = first.data.total_count;
  const totalPages = Math.ceil(totalCount / perPage);

  // Fetch remaining pages concurrently
  if (totalPages > 1) {
    const remaining = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const results = await Promise.all(remaining.map((p) => fetchPage(p)));

    for (const result of results) {
      allRepos.push(...mapRepos(result.data));
      pageTiming.push(result.timing);
    }
  }

  return {
    repos: allRepos,
    timing: {
      tokenGenerationMs: Math.round(tokenGenerationMs * 100) / 100,
      pages: pageTiming,
      totalPages,
      totalRepos: allRepos.length,
    },
  };
}

/**
 * Fetch a single repository using the GitHub App installation token.
 * Returns null if the repository is not accessible to the installation.
 */
export async function getInstallationRepository(
  config: GitHubAppConfig,
  owner: string,
  repo: string,
): Promise<InstallationRepository | null> {
  const token = await generateInstallationToken(config);

  const response = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Open-Inspect",
    },
  });

  if (response.status === 404 || response.status === 403) {
    return null;
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch repository: ${response.status} ${error}`);
  }

  const data = (await response.json()) as {
    id: number;
    name: string;
    full_name: string;
    description: string | null;
    private: boolean;
    default_branch: string;
    owner: { login: string };
  };

  return {
    id: data.id,
    owner: data.owner.login,
    name: data.name,
    fullName: data.full_name,
    description: data.description,
    private: data.private,
    defaultBranch: data.default_branch,
  };
}

/**
 * Check if GitHub App credentials are configured.
 */
export function isGitHubAppConfigured(env: {
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}): boolean {
  return !!(env.githubAppId && env.githubAppPrivateKey && env.githubAppInstallationId);
}

/**
 * Get GitHub App config from environment config.
 */
export function getGitHubAppConfig(env: {
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}): GitHubAppConfig | null {
  if (!isGitHubAppConfigured(env)) {
    return null;
  }

  return {
    appId: env.githubAppId!,
    privateKey: env.githubAppPrivateKey!,
    installationId: env.githubAppInstallationId!,
  };
}
