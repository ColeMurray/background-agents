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
export const GITHUB_FETCH_TIMEOUT_MS = 60_000;

/** Cache installation tokens for this duration at most (ms). */
export const INSTALLATION_TOKEN_CACHE_MAX_AGE_MS = 50 * 60 * 1000;

/** Require at least this much remaining lifetime before using a cached token (ms). */
export const INSTALLATION_TOKEN_MIN_REMAINING_MS = 5 * 60 * 1000;

/** Upper bound for KV cache TTL (seconds). */
export const INSTALLATION_TOKEN_CACHE_MAX_TTL_SECONDS = 3600;

const INSTALLATION_TOKEN_CACHE_KEY_PREFIX = "github:installation-token:v1";

interface InstallationTokenCacheBindings {
  REPOS_CACHE?: KVNamespace;
}

interface CachedInstallationToken {
  token: string;
  expiresAtEpochMs: number;
  cachedAtEpochMs: number;
}

interface GitHubHttpError extends Error {
  status?: number;
}

function createHttpError(message: string, status: number): GitHubHttpError {
  const error = new Error(message) as GitHubHttpError;
  error.status = status;
  return error;
}

const installationTokenMemoryCache = new Map<string, CachedInstallationToken>();
const installationTokenRefreshInFlight = new Map<string, Promise<CachedInstallationToken>>();
const importedPrivateKeyCache = new Map<string, Promise<CryptoKey>>();

/** Fetch with an AbortController timeout. */
export function fetchWithTimeout(
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
 * Import and cache RSA private key for signing.
 */
async function importPrivateKeyCached(pem: string): Promise<CryptoKey> {
  const existing = importedPrivateKeyCache.get(pem);
  if (existing) {
    return existing;
  }

  const inFlight = importPrivateKey(pem).catch((error) => {
    importedPrivateKeyCache.delete(pem);
    throw error;
  });
  importedPrivateKeyCache.set(pem, inFlight);
  return inFlight;
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
  const key = await importPrivateKeyCached(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  const encodedSignature = base64UrlEncode(new Uint8Array(signature));

  return `${signingInput}.${encodedSignature}`;
}

/**
 * Exchange JWT for an installation access token and expiry metadata.
 */
async function getInstallationTokenWithMetadata(
  jwt: string,
  installationId: string
): Promise<InstallationTokenResponse> {
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

  return (await response.json()) as InstallationTokenResponse;
}

function getInstallationTokenCacheKey(config: GitHubAppConfig): string {
  return `${INSTALLATION_TOKEN_CACHE_KEY_PREFIX}:${config.appId}:${config.installationId}`;
}

function isTokenUsable(cached: CachedInstallationToken, nowEpochMs = Date.now()): boolean {
  const cacheAgeMs = nowEpochMs - cached.cachedAtEpochMs;
  if (cacheAgeMs >= INSTALLATION_TOKEN_CACHE_MAX_AGE_MS) {
    return false;
  }
  return nowEpochMs < cached.expiresAtEpochMs - INSTALLATION_TOKEN_MIN_REMAINING_MS;
}

async function readInstallationTokenFromKv(
  env: InstallationTokenCacheBindings | undefined,
  cacheKey: string
): Promise<CachedInstallationToken | null> {
  if (!env?.REPOS_CACHE) {
    return null;
  }

  try {
    const cached = await env.REPOS_CACHE.get<CachedInstallationToken>(cacheKey, "json");
    return cached ?? null;
  } catch {
    return null;
  }
}

async function writeInstallationTokenToKv(
  env: InstallationTokenCacheBindings | undefined,
  cacheKey: string,
  cached: CachedInstallationToken
): Promise<void> {
  if (!env?.REPOS_CACHE) {
    return;
  }

  const nowEpochMs = Date.now();
  const remainingLifetimeMs = cached.expiresAtEpochMs - nowEpochMs;
  if (remainingLifetimeMs <= 0) {
    return;
  }

  const cacheBoundLifetimeMs = Math.min(remainingLifetimeMs, INSTALLATION_TOKEN_CACHE_MAX_AGE_MS);
  const ttlSeconds = Math.max(
    1,
    Math.min(INSTALLATION_TOKEN_CACHE_MAX_TTL_SECONDS, Math.floor(cacheBoundLifetimeMs / 1000))
  );

  try {
    await env.REPOS_CACHE.put(cacheKey, JSON.stringify(cached), { expirationTtl: ttlSeconds });
  } catch {
    // Cache failures are non-fatal.
  }
}

async function invalidateInstallationTokenCache(
  env: InstallationTokenCacheBindings | undefined,
  cacheKey: string
): Promise<void> {
  installationTokenMemoryCache.delete(cacheKey);
  installationTokenRefreshInFlight.delete(cacheKey);

  if (!env?.REPOS_CACHE) {
    return;
  }

  try {
    await env.REPOS_CACHE.delete(cacheKey);
  } catch {
    // Cache invalidation failures are non-fatal.
  }
}

async function refreshInstallationToken(
  config: GitHubAppConfig,
  env: InstallationTokenCacheBindings | undefined,
  cacheKey: string
): Promise<CachedInstallationToken> {
  const nowEpochMs = Date.now();
  const jwt = await generateAppJwt(config.appId, config.privateKey);
  const tokenData = await getInstallationTokenWithMetadata(jwt, config.installationId);
  const parsedExpiresAtEpochMs = Date.parse(tokenData.expires_at);
  const cached: CachedInstallationToken = {
    token: tokenData.token,
    expiresAtEpochMs: Number.isFinite(parsedExpiresAtEpochMs)
      ? parsedExpiresAtEpochMs
      : nowEpochMs + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS,
    cachedAtEpochMs: nowEpochMs,
  };

  installationTokenMemoryCache.set(cacheKey, cached);
  await writeInstallationTokenToKv(env, cacheKey, cached);
  return cached;
}

/**
 * Get installation token with in-memory + KV caching.
 */
export async function getCachedInstallationToken(
  config: GitHubAppConfig,
  env?: InstallationTokenCacheBindings,
  options?: { forceRefresh?: boolean }
): Promise<string> {
  const cacheKey = getInstallationTokenCacheKey(config);
  const forceRefresh = options?.forceRefresh ?? false;

  if (!forceRefresh) {
    const memoryCached = installationTokenMemoryCache.get(cacheKey);
    if (memoryCached && isTokenUsable(memoryCached)) {
      return memoryCached.token;
    }

    const kvCached = await readInstallationTokenFromKv(env, cacheKey);
    if (kvCached && isTokenUsable(kvCached)) {
      installationTokenMemoryCache.set(cacheKey, kvCached);
      return kvCached.token;
    }

    const inFlight = installationTokenRefreshInFlight.get(cacheKey);
    if (inFlight) {
      const shared = await inFlight;
      return shared.token;
    }
  }

  const refreshPromise = refreshInstallationToken(config, env, cacheKey).finally(() => {
    installationTokenRefreshInFlight.delete(cacheKey);
  });
  installationTokenRefreshInFlight.set(cacheKey, refreshPromise);

  const refreshed = await refreshPromise;
  return refreshed.token;
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
  config: GitHubAppConfig,
  env?: InstallationTokenCacheBindings
): Promise<{ repos: InstallationRepository[]; timing: ListReposTiming }> {
  const tokenStart = performance.now();
  let token = await getCachedInstallationToken(config, env);
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
      const body = await response.text();
      throw createHttpError(
        `Failed to list installation repositories (page ${page}): ${response.status} ${body}`,
        response.status
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
  let first: { data: ListInstallationReposResponse; timing: GitHubPageTiming };
  try {
    first = await fetchPage(1);
  } catch (error) {
    const status = (error as GitHubHttpError | undefined)?.status;
    if (status !== 401) {
      throw error;
    }

    await invalidateInstallationTokenCache(env, getInstallationTokenCacheKey(config));
    token = await getCachedInstallationToken(config, env, { forceRefresh: true });
    headers.Authorization = `Bearer ${token}`;
    first = await fetchPage(1);
  }
  const allRepos = mapRepos(first.data);
  const pageTiming: GitHubPageTiming[] = [first.timing];

  const totalCount = first.data.total_count;
  const totalPages = Math.ceil(totalCount / perPage);

  // Fetch remaining pages concurrently.
  // No 401 retry here — the token was just obtained (or refreshed) for page 1,
  // so a mid-pagination auth failure is not expected.
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
  env?: InstallationTokenCacheBindings
): Promise<InstallationRepository | null> {
  const cacheKey = getInstallationTokenCacheKey(config);
  let forceRefresh = false;
  let response!: Response;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getCachedInstallationToken(config, env, { forceRefresh });
    response = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Open-Inspect",
      },
    });

    if (response.status !== 401) {
      break;
    }

    await invalidateInstallationTokenCache(env, cacheKey);
    forceRefresh = true;
  }

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
 * List branches for a repository using the GitHub App installation token.
 */
export async function listRepositoryBranches(
  config: GitHubAppConfig,
  owner: string,
  repo: string,
  env?: InstallationTokenCacheBindings
): Promise<{ name: string }[]> {
  const token = await getCachedInstallationToken(config, env);
  const branches: { name: string }[] = [];
  let page = 1;

  // Paginate through branches (100 per page, cap at 500)
  while (branches.length < 500) {
    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Open-Inspect",
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list branches: ${response.status} ${error}`);
    }

    const data = (await response.json()) as { name: string }[];
    branches.push(...data.map((b) => ({ name: b.name })));

    if (data.length < 100) break;
    page++;
  }

  return branches;
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
