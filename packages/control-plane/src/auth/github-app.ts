/**
 * GitHub App authentication for generating installation tokens.
 *
 * Uses Web Crypto API for RSA-SHA256 signing (available in Cloudflare Workers).
 *
 * Token flow:
 * 1. Generate JWT signed with App's private key
 * 2. Exchange JWT for installation access token via GitHub API
 * 3. Token valid for 1 hour
 */

import type { InstallationRepository } from "@open-inspect/shared";

/** Timeout for individual GitHub API requests (ms). */
const GITHUB_FETCH_TIMEOUT_MS = 60_000;

/** Fetch with an AbortController timeout. */
function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = GITHUB_FETCH_TIMEOUT_MS
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
  privateKey: string; // PEM format
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
 * Base64URL encode a Uint8Array or string.
 */
function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;

  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Parse PEM-encoded private key to raw bytes.
 */
function parsePemPrivateKey(pem: string): Uint8Array {
  // Remove PEM header/footer and newlines
  const pemContents = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  // Decode base64
  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Import RSA private key for signing.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemPrivateKey(pem);

  // Try PKCS#8 format first (BEGIN PRIVATE KEY)
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );
  } catch {
    // Fall back to trying as PKCS#1 (BEGIN RSA PRIVATE KEY)
    // Cloudflare Workers may not support PKCS#1 directly,
    // so we may need to convert or use a different approach
    throw new Error(
      "Unable to import private key. Ensure it is in PKCS#8 format. " +
        "Convert with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem"
    );
  }
}

/**
 * Generate a JWT for GitHub App authentication.
 *
 * @param appId - GitHub App ID
 * @param privateKey - PEM-encoded private key
 * @returns Signed JWT valid for 10 minutes
 */
export async function generateAppJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // JWT header
  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  // JWT payload
  const payload = {
    iat: now - 60, // Issued 60 seconds ago (clock skew tolerance)
    exp: now + 600, // Expires in 10 minutes
    iss: appId,
  };

  // Encode header and payload
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Sign with RSA-SHA256
  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  const encodedSignature = base64UrlEncode(new Uint8Array(signature));

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
 * This is the main entry point for token generation.
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
 *
 * @param config - GitHub App configuration
 * @returns repos and per-page timing breakdown for diagnostics
 */
export async function listInstallationRepositories(
  config: GitHubAppConfig
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
    page: number
  ): Promise<{ data: ListInstallationReposResponse; timing: GitHubPageTiming }> => {
    const url = `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`;
    const pageStart = performance.now();

    const response = await fetchWithTimeout(url, { headers });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to list installation repositories (page ${page}): ${response.status} ${error}`
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
  repo: string
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
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
}): boolean {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID);
}

/**
 * Get GitHub App config from environment.
 */
export function getGitHubAppConfig(env: {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
}): GitHubAppConfig | null {
  if (!isGitHubAppConfigured(env)) {
    return null;
  }

  return {
    appId: env.GITHUB_APP_ID!,
    privateKey: env.GITHUB_APP_PRIVATE_KEY!,
    installationId: env.GITHUB_APP_INSTALLATION_ID!,
  };
}
