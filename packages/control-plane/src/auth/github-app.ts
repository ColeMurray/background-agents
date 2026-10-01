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

import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { DEFAULT_APP_NAME } from "@open-inspect/shared/app-name";
import type { CacheStore } from "@open-inspect/shared/cache-store";
import { sha256Hex } from "@open-inspect/shared/service-auth";
import { z } from "zod";
import {
  repositoryCredentialScope,
  type CredentialScope,
} from "../source-control/credential-scope";

import { base64UrlEncode } from "./encoding";

/** Timeout for individual GitHub API requests (ms). */
const GITHUB_FETCH_TIMEOUT_MS = 60_000;

/** Cache installation tokens for this duration at most (ms). */
export const INSTALLATION_TOKEN_CACHE_MAX_AGE_MS = 50 * 60 * 1000;

/** Require at least this much remaining lifetime before using a cached token (ms). */
export const INSTALLATION_TOKEN_MIN_REMAINING_MS = 5 * 60 * 1000;

/** Maximum distinct token scopes retained in the process cache. */
export const INSTALLATION_TOKEN_MEMORY_CACHE_MAX_ENTRIES = 128;

/** Upper bound for KV cache TTL (seconds). */
const INSTALLATION_TOKEN_CACHE_MAX_TTL_SECONDS = 3600;

const INSTALLATION_TOKEN_CACHE_KEY_PREFIX = "github:installation-token:v2";

export type TokenScope = CredentialScope;

interface InstallationTokenOptions {
  scope: TokenScope;
  forceRefresh?: boolean;
}

interface InstallationTokenCacheBindings {
  cacheStore?: CacheStore;
  /** User-Agent header sent on outbound GitHub API requests. */
  userAgent?: string;
}

function resolveUserAgent(env: InstallationTokenCacheBindings | undefined): string {
  const value = env?.userAgent?.trim();
  return value && value.length > 0 ? value : DEFAULT_APP_NAME;
}

const cachedInstallationTokenSchema = z.object({
  token: z.string(),
  expiresAtEpochMs: z.number(),
  cachedAtEpochMs: z.number(),
});

type CachedInstallationToken = z.infer<typeof cachedInstallationTokenSchema>;

interface GitHubHttpError extends Error {
  status?: number;
}

function createHttpError(message: string, status: number): GitHubHttpError {
  const error = new Error(message) as GitHubHttpError;
  error.status = status;
  return error;
}

const installationTokenMemoryCache = new Map<string, CachedInstallationToken>();
const installationTokenRefreshInFlight = new Map<
  string,
  { promise: Promise<CachedInstallationToken>; options: { forceRefresh: boolean } }
>();
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
interface GitHubPageTiming {
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

const installationTokenResponseSchema = z
  .object({
    token: z.string(),
    expires_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  })
  .transform(({ token, expires_at }) => ({
    token,
    expiresAtEpochMs: Date.parse(expires_at),
  }));

/** GitHub installation token response. */
type InstallationTokenResponse = z.infer<typeof installationTokenResponseSchema>;

const installationRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
  archived: z.boolean(),
  default_branch: z.string(),
  language: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  owner: z.object({ login: z.string() }),
});

const listInstallationReposResponseSchema = z.object({
  total_count: z.number(),
  repositories: z.array(installationRepositorySchema),
});

type ListInstallationReposResponse = z.infer<typeof listInstallationReposResponseSchema>;

const repositoryBranchesResponseSchema = z.array(z.object({ name: z.string() }));

/**
 * Parse PEM-encoded private key to raw bytes.
 */
function parsePemPrivateKey(pem: string): Uint8Array {
  // Remove PEM header/footer and newlines, including the two-character
  // `\n` an environment file leaves in place of a newline.
  const pemContents = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
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
async function generateAppJwt(appId: string, privateKey: string): Promise<string> {
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
  installationId: string,
  userAgent: string,
  scope: TokenScope
): Promise<InstallationTokenResponse> {
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": userAgent,
      ...(scope.kind === "repositories" ? { "Content-Type": "application/json" } : {}),
    },
    ...(scope.kind === "repositories"
      ? { body: JSON.stringify({ repository_ids: scope.repositoryIds }) }
      : {}),
  });

  if (!response.ok) {
    const error = await response.text();
    // Attach the HTTP status so callers can classify transient (5xx/429)
    // vs permanent failures rather than substring-matching the message.
    throw Object.assign(
      new Error(`Failed to get installation token: ${response.status} ${error}`),
      { status: response.status }
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("Failed to get installation token: invalid response");
  }

  const parsed = installationTokenResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Failed to get installation token: invalid response");
  }
  return parsed.data;
}

export async function getInstallationTokenCacheKey(
  config: GitHubAppConfig,
  scope: TokenScope
): Promise<string> {
  let scopeHash = "all";
  if (scope.kind === "repositories") {
    const ids = repositoryCredentialScope(scope.repositoryIds).repositoryIds;
    scopeHash = await sha256Hex(JSON.stringify(ids));
  }
  return `${INSTALLATION_TOKEN_CACHE_KEY_PREFIX}:${config.appId}:${config.installationId}:${scopeHash}`;
}

function isTokenUsable(cached: CachedInstallationToken, nowEpochMs = Date.now()): boolean {
  const cacheAgeMs = nowEpochMs - cached.cachedAtEpochMs;
  if (cacheAgeMs >= INSTALLATION_TOKEN_CACHE_MAX_AGE_MS) {
    return false;
  }
  return nowEpochMs < cached.expiresAtEpochMs - INSTALLATION_TOKEN_MIN_REMAINING_MS;
}

function cacheInstallationTokenInMemory(cacheKey: string, cached: CachedInstallationToken): void {
  const nowEpochMs = Date.now();
  for (const [key, token] of installationTokenMemoryCache) {
    if (!isTokenUsable(token, nowEpochMs)) installationTokenMemoryCache.delete(key);
  }
  installationTokenMemoryCache.delete(cacheKey);
  if (!isTokenUsable(cached, nowEpochMs)) return;
  installationTokenMemoryCache.set(cacheKey, cached);
  if (installationTokenMemoryCache.size > INSTALLATION_TOKEN_MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = installationTokenMemoryCache.keys().next().value;
    if (oldestKey !== undefined) installationTokenMemoryCache.delete(oldestKey);
  }
}

async function readInstallationTokenFromCache(
  env: InstallationTokenCacheBindings | undefined,
  cacheKey: string
): Promise<CachedInstallationToken | null> {
  if (!env?.cacheStore) {
    return null;
  }

  try {
    const result = cachedInstallationTokenSchema.safeParse(
      await env.cacheStore.get(cacheKey, "json")
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function writeInstallationTokenToCache(
  env: InstallationTokenCacheBindings | undefined,
  cacheKey: string,
  cached: CachedInstallationToken
): Promise<void> {
  if (!env?.cacheStore) {
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
    await env.cacheStore.put(cacheKey, JSON.stringify(cached), { expirationTtl: ttlSeconds });
  } catch {
    // Cache failures are non-fatal.
  }
}

export async function invalidateInstallationTokenCache(
  env: InstallationTokenCacheBindings | undefined,
  cacheKey: string
): Promise<void> {
  installationTokenMemoryCache.delete(cacheKey);
  const pending = installationTokenRefreshInFlight.get(cacheKey);
  if (pending) pending.options.forceRefresh = true;

  if (!env?.cacheStore) {
    return;
  }

  try {
    await env.cacheStore.delete(cacheKey);
  } catch {
    // Cache invalidation failures are non-fatal.
  }
}

async function refreshInstallationToken(
  config: GitHubAppConfig,
  env: InstallationTokenCacheBindings | undefined,
  cacheKey: string,
  scope: TokenScope
): Promise<CachedInstallationToken> {
  const nowEpochMs = Date.now();
  const jwt = await generateAppJwt(config.appId, config.privateKey);
  const tokenData = await getInstallationTokenWithMetadata(
    jwt,
    config.installationId,
    resolveUserAgent(env),
    scope
  );
  const cached: CachedInstallationToken = {
    token: tokenData.token,
    expiresAtEpochMs: tokenData.expiresAtEpochMs,
    cachedAtEpochMs: nowEpochMs,
  };

  cacheInstallationTokenInMemory(cacheKey, cached);
  await writeInstallationTokenToCache(env, cacheKey, cached);
  return cached;
}

async function getOrRefreshCachedInstallationToken(
  config: GitHubAppConfig,
  env: InstallationTokenCacheBindings | undefined,
  options: InstallationTokenOptions
): Promise<CachedInstallationToken> {
  const scope: TokenScope =
    options.scope.kind === "all"
      ? options.scope
      : repositoryCredentialScope(options.scope.repositoryIds);
  const cacheKey = await getInstallationTokenCacheKey(config, scope);
  const forceRefresh = options.forceRefresh ?? false;

  const pending = installationTokenRefreshInFlight.get(cacheKey);
  if (pending) {
    if (forceRefresh) pending.options.forceRefresh = true;
    return pending.promise;
  }

  if (!forceRefresh) {
    const memoryCached = installationTokenMemoryCache.get(cacheKey);
    if (memoryCached && isTokenUsable(memoryCached)) {
      // Re-insert to mark most recently used; expired entries are pruned on insert.
      installationTokenMemoryCache.delete(cacheKey);
      installationTokenMemoryCache.set(cacheKey, memoryCached);
      return memoryCached;
    }
    installationTokenMemoryCache.delete(cacheKey);
  }

  const refreshOptions = { forceRefresh };
  const refreshPromise = (async () => {
    if (!refreshOptions.forceRefresh) {
      const persistentCached = await readInstallationTokenFromCache(env, cacheKey);
      // Invalidation or a forced caller can supersede a pending cache read.
      if (!refreshOptions.forceRefresh && persistentCached && isTokenUsable(persistentCached)) {
        cacheInstallationTokenInMemory(cacheKey, persistentCached);
        // Forced callers must not join work that has already selected a cache hit.
        if (installationTokenRefreshInFlight.get(cacheKey)?.options === refreshOptions) {
          installationTokenRefreshInFlight.delete(cacheKey);
        }
        return persistentCached;
      }
    }
    return refreshInstallationToken(config, env, cacheKey, scope);
  })().finally(() => {
    if (installationTokenRefreshInFlight.get(cacheKey)?.promise === refreshPromise) {
      installationTokenRefreshInFlight.delete(cacheKey);
    }
  });
  installationTokenRefreshInFlight.set(cacheKey, {
    promise: refreshPromise,
    options: refreshOptions,
  });

  return refreshPromise;
}

/**
 * Get installation token with in-memory + KV caching.
 */
export async function getCachedInstallationToken(
  config: GitHubAppConfig,
  env: InstallationTokenCacheBindings | undefined,
  options: InstallationTokenOptions
): Promise<string> {
  const cached = await getOrRefreshCachedInstallationToken(config, env, options);
  return cached.token;
}

/**
 * Like {@link getCachedInstallationToken}, but also returns the absolute epoch
 * milliseconds at which the token expires. Used by callers that need to
 * forward the token's lifetime to a client (e.g. the sandbox credential
 * helper, which caches its own copy until shortly before expiry).
 */
export async function getCachedInstallationTokenWithExpiry(
  config: GitHubAppConfig,
  env: InstallationTokenCacheBindings | undefined,
  options: InstallationTokenOptions
): Promise<{ token: string; expiresAtEpochMs: number }> {
  const cached = await getOrRefreshCachedInstallationToken(config, env, options);
  return { token: cached.token, expiresAtEpochMs: cached.expiresAtEpochMs };
}

// Re-export from shared for backward compatibility
export type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";

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
  const scope: TokenScope = { kind: "all" };
  let token = await getCachedInstallationToken(config, env, { scope });
  const tokenGenerationMs = performance.now() - tokenStart;

  const perPage = 100;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": resolveUserAgent(env),
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

    const raw = await response.json();
    const parsed = listInstallationReposResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Failed to list installation repositories (page ${page}): invalid response`);
    }
    const data = parsed.data;
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
      archived: repo.archived,
      defaultBranch: repo.default_branch,
      language: repo.language,
      topics: repo.topics,
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

    await invalidateInstallationTokenCache(env, await getInstallationTokenCacheKey(config, scope));
    token = await getCachedInstallationToken(config, env, { scope, forceRefresh: true });
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
  const scope: TokenScope = { kind: "all" };
  const cacheKey = await getInstallationTokenCacheKey(config, scope);
  let forceRefresh = false;
  let response!: Response;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getCachedInstallationToken(config, env, { scope, forceRefresh });
    response = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": resolveUserAgent(env),
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

  const raw = await response.json();
  const parsed = installationRepositorySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Failed to fetch repository: invalid response");
  }
  const data = parsed.data;

  return {
    id: data.id,
    owner: data.owner.login,
    name: data.name,
    fullName: data.full_name,
    description: data.description,
    private: data.private,
    archived: data.archived,
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
  const token = await getCachedInstallationToken(config, env, { scope: { kind: "all" } });
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
          "User-Agent": resolveUserAgent(env),
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list branches: ${response.status} ${error}`);
    }

    const raw = await response.json();
    const parsed = repositoryBranchesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Failed to list branches: invalid response");
    }
    const data = parsed.data;
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
