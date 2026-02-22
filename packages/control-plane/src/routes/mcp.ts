import { GlobalSecretsStore } from "../db/global-secrets";
import {
  RepoMcpConfigStore,
  collectSecretRefs,
  validateRepoMcpConfig,
  type RepoMcpConfig,
} from "../db/repo-mcp-config";
import { RepoSecretsStore } from "../db/repo-secrets";
import type { Env } from "../types";
import { createLogger } from "../logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  resolveInstalledRepo,
} from "./shared";

const REPOS_CACHE_KEY = "repos:list";
const logger = createLogger("router:mcp");

async function collectAvailableSecretKeys(
  env: Env,
  repoId: number
): Promise<{ available: Set<string>; globalCount: number; repoCount: number }> {
  const available = new Set<string>();
  let globalCount = 0;
  let repoCount = 0;

  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return { available, globalCount, repoCount };
  }

  const repoStore = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
  const globalStore = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

  const [repoKeys, globalKeys] = await Promise.all([
    repoStore.listSecretKeys(repoId),
    globalStore.listSecretKeys().catch(() => []),
  ]);

  repoCount = repoKeys.length;
  globalCount = globalKeys.length;

  for (const entry of repoKeys) available.add(entry.key.toUpperCase());
  for (const entry of globalKeys) available.add(entry.key.toUpperCase());

  return { available, globalCount, repoCount };
}

function parseBodyAsConfig(body: unknown): RepoMcpConfig {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object");
  }

  const candidate =
    "mcpConfig" in (body as Record<string, unknown>)
      ? (body as { mcpConfig: unknown }).mcpConfig
      : body;
  return validateRepoMcpConfig(candidate);
}

async function validateConfigAgainstSecrets(
  config: RepoMcpConfig,
  env: Env,
  repoId: number
): Promise<{ missingSecretKeys: string[]; referencedSecretKeys: string[] }> {
  const referencedSecretKeys = collectSecretRefs(config);
  if (referencedSecretKeys.length === 0) {
    return { missingSecretKeys: [], referencedSecretKeys: [] };
  }

  const { available } = await collectAvailableSecretKeys(env, repoId);
  const missingSecretKeys = referencedSecretKeys.filter((key) => !available.has(key));
  return { missingSecretKeys, referencedSecretKeys };
}

async function handleSetRepoMcpConfig(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) return error("MCP configuration storage is not configured", 503);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required");

  let resolved;
  try {
    resolved = await resolveInstalledRepo(env, owner, name);
    if (!resolved) return error("Repository is not installed for the GitHub App", 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  let config: RepoMcpConfig;
  try {
    config = parseBodyAsConfig(body);
  } catch (e) {
    return error(e instanceof Error ? e.message : "Invalid MCP configuration", 400);
  }

  const { missingSecretKeys, referencedSecretKeys } = await validateConfigAgainstSecrets(
    config,
    env,
    resolved.repoId
  );
  if (missingSecretKeys.length > 0) {
    return error(`MCP config references missing secret keys: ${missingSecretKeys.join(", ")}`, 400);
  }

  try {
    const store = new RepoMcpConfigStore(env.DB);
    await store.upsert(resolved.repoOwner, resolved.repoName, config);
    await env.REPOS_CACHE.delete(REPOS_CACHE_KEY);

    logger.info("repo.mcp_updated", {
      event: "repo.mcp_updated",
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      servers_count: Object.keys(config.mcpServers).length,
      referenced_secret_keys_count: referencedSecretKeys.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "updated",
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      mcpConfig: config,
      validation: { referencedSecretKeys, missingSecretKeys: [] },
    });
  } catch (e) {
    logger.error("Failed to update MCP config", {
      error: e instanceof Error ? e.message : String(e),
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to update MCP configuration", 500);
  }
}

async function handleGetRepoMcpConfig(
  _request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  if (!env.DB) return error("MCP configuration storage is not configured", 503);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required");

  const store = new RepoMcpConfigStore(env.DB);
  try {
    const config = await store.get(owner, name);
    return json({
      repo: `${owner.toLowerCase()}/${name.toLowerCase()}`,
      mcpConfig: config,
    });
  } catch (e) {
    logger.error("Failed to fetch MCP config", {
      error: e instanceof Error ? e.message : String(e),
    });
    return error("Failed to get MCP configuration", 500);
  }
}

async function handleValidateRepoMcpConfig(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  if (!env.DB) return error("MCP configuration storage is not configured", 503);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required");

  let resolved;
  try {
    resolved = await resolveInstalledRepo(env, owner, name);
    if (!resolved) return error("Repository is not installed for the GitHub App", 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  let config: RepoMcpConfig;
  try {
    config = parseBodyAsConfig(body);
  } catch (e) {
    return json({
      valid: false,
      errors: [e instanceof Error ? e.message : "Invalid MCP configuration"],
      missingSecretKeys: [],
      referencedSecretKeys: [],
    });
  }

  const { missingSecretKeys, referencedSecretKeys } = await validateConfigAgainstSecrets(
    config,
    env,
    resolved.repoId
  );

  return json({
    valid: missingSecretKeys.length === 0,
    errors:
      missingSecretKeys.length > 0
        ? [`MCP config references missing secret keys: ${missingSecretKeys.join(", ")}`]
        : [],
    missingSecretKeys,
    referencedSecretKeys,
  });
}

async function handleMcpHealth(
  _request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  if (!env.DB) return error("MCP configuration storage is not configured", 503);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required");

  const store = new RepoMcpConfigStore(env.DB);
  const config = await store.get(owner, name);
  if (!config) {
    return json({
      status: "not_configured",
      servers: [],
    });
  }

  const servers = Object.entries(config.mcpServers).map(([serverName, server]) => ({
    serverName,
    enabled: server.enabled !== false,
    transport: server.transport,
    status: "not_tested",
  }));

  return json({
    status: "configured",
    servers,
  });
}

export const mcpRoutes: Route[] = [
  {
    method: "PUT",
    pattern: parsePattern("/repos/:owner/:name/mcp"),
    handler: handleSetRepoMcpConfig,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/mcp"),
    handler: handleGetRepoMcpConfig,
  },
  {
    method: "POST",
    pattern: parsePattern("/repos/:owner/:name/mcp/validate"),
    handler: handleValidateRepoMcpConfig,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/mcp/health"),
    handler: handleMcpHealth,
  },
];
