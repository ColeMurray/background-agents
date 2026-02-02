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

  const response = await fetch(url, {
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
 * @param config - GitHub App configuration
 * @returns Array of repositories the App can access
 */
export async function listInstallationRepositories(
  config: GitHubAppConfig
): Promise<InstallationRepository[]> {
  const token = await generateInstallationToken(config);

  const allRepos: InstallationRepository[] = [];
  let page = 1;
  const perPage = 100;

  // Paginate through all repositories
  while (true) {
    const url = `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Open-Inspect",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list installation repositories: ${response.status} ${error}`);
    }

    const data = (await response.json()) as ListInstallationReposResponse;

    const repos = data.repositories.map((repo) => ({
      id: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description,
      private: repo.private,
      defaultBranch: repo.default_branch,
    }));

    allRepos.push(...repos);

    // Check if we've fetched all pages
    if (data.repositories.length < perPage || allRepos.length >= data.total_count) {
      break;
    }

    page++;
  }

  return allRepos;
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

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
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
