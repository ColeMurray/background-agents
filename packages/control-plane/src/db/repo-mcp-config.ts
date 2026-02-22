/** D1 batch() supports at most 100 statements per call. */
const D1_BATCH_LIMIT = 100;
const SECRET_REF_PREFIX = "secret:";

/** Keep MCP payload bounded so sandbox env injection stays safe. */
export const MAX_MCP_CONFIG_BYTES = 65536;

interface RepoMcpConfigRow {
  repo_owner: string;
  repo_name: string;
  mcp_servers: string;
}

export class RepoMcpValidationError extends Error {}

export type McpServerTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  transport: McpServerTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface RepoMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepoMcpValidationError(message);
  }
}

function normalizeServerConfig(serverName: string, value: unknown): McpServerConfig {
  assertRecord(value, `MCP server '${serverName}' must be an object`);

  const transport = value.transport;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw new RepoMcpValidationError(
      `MCP server '${serverName}' has invalid transport. Expected stdio, http, or sse`
    );
  }

  const config: McpServerConfig = { transport };

  if (value.command !== undefined) {
    if (typeof value.command !== "string" || value.command.length === 0) {
      throw new RepoMcpValidationError(`MCP server '${serverName}' has invalid command`);
    }
    config.command = value.command;
  }
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
      throw new RepoMcpValidationError(
        `MCP server '${serverName}' args must be an array of strings`
      );
    }
    config.args = value.args;
  }
  if (value.url !== undefined) {
    if (typeof value.url !== "string" || value.url.length === 0) {
      throw new RepoMcpValidationError(`MCP server '${serverName}' has invalid url`);
    }
    config.url = value.url;
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new RepoMcpValidationError(`MCP server '${serverName}' enabled must be boolean`);
    }
    config.enabled = value.enabled;
  }
  if (value.env !== undefined) {
    assertRecord(value.env, `MCP server '${serverName}' env must be an object`);
    for (const [key, envValue] of Object.entries(value.env)) {
      if (typeof envValue !== "string") {
        throw new RepoMcpValidationError(
          `MCP server '${serverName}' env key '${key}' must be string`
        );
      }
    }
    config.env = value.env as Record<string, string>;
  }
  if (value.headers !== undefined) {
    assertRecord(value.headers, `MCP server '${serverName}' headers must be an object`);
    for (const [key, headerValue] of Object.entries(value.headers)) {
      if (typeof headerValue !== "string") {
        throw new RepoMcpValidationError(
          `MCP server '${serverName}' header '${key}' must be string`
        );
      }
    }
    config.headers = value.headers as Record<string, string>;
  }

  if (transport === "stdio" && !config.command) {
    throw new RepoMcpValidationError(`MCP server '${serverName}' (stdio) requires command`);
  }
  if ((transport === "http" || transport === "sse") && !config.url) {
    throw new RepoMcpValidationError(`MCP server '${serverName}' (${transport}) requires url`);
  }

  return config;
}

function parseConfig(mcpServersJson: string): RepoMcpConfig {
  const parsed = JSON.parse(mcpServersJson) as unknown;
  assertRecord(parsed, "Stored MCP configuration is invalid");
  const mcpServers = parsed as Record<string, unknown>;

  const normalized: Record<string, McpServerConfig> = {};
  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    normalized[serverName] = normalizeServerConfig(serverName, serverConfig);
  }

  return { mcpServers: normalized };
}

export function validateRepoMcpConfig(input: unknown): RepoMcpConfig {
  assertRecord(input, "MCP configuration must be an object");
  assertRecord(input.mcpServers, "MCP configuration must include mcpServers object");

  const normalized: Record<string, McpServerConfig> = {};
  for (const [serverName, serverConfig] of Object.entries(input.mcpServers)) {
    normalized[serverName] = normalizeServerConfig(serverName, serverConfig);
  }

  const config: RepoMcpConfig = { mcpServers: normalized };
  const bytes = new TextEncoder().encode(JSON.stringify(config.mcpServers)).length;
  if (bytes > MAX_MCP_CONFIG_BYTES) {
    throw new RepoMcpValidationError(`MCP configuration exceeds ${MAX_MCP_CONFIG_BYTES} bytes`);
  }

  return config;
}

function collectSecretRefsInRecord(record: Record<string, string>, refs: Set<string>): void {
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.startsWith(SECRET_REF_PREFIX)) {
      refs.add(value.slice(SECRET_REF_PREFIX.length).toUpperCase());
    }
  }
}

export function collectSecretRefs(config: RepoMcpConfig): string[] {
  const refs = new Set<string>();
  for (const server of Object.values(config.mcpServers)) {
    if (server.env) collectSecretRefsInRecord(server.env, refs);
    if (server.headers) collectSecretRefsInRecord(server.headers, refs);
  }
  return [...refs].sort();
}

export function resolveMcpSecretRefs(
  config: RepoMcpConfig,
  secrets: Record<string, string>
): { resolvedConfig: RepoMcpConfig; missingSecretKeys: string[] } {
  const missingKeys = new Set<string>();
  const resolvedServers: Record<string, McpServerConfig> = {};

  const resolveRecord = (record?: Record<string, string>): Record<string, string> | undefined => {
    if (!record) return undefined;
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value.startsWith(SECRET_REF_PREFIX)) {
        const secretKey = value.slice(SECRET_REF_PREFIX.length).toUpperCase();
        const resolved = secrets[secretKey];
        if (resolved === undefined) {
          missingKeys.add(secretKey);
          continue;
        }
        output[key] = resolved;
      } else {
        output[key] = value;
      }
    }
    return output;
  };

  for (const [name, server] of Object.entries(config.mcpServers)) {
    resolvedServers[name] = {
      ...server,
      env: resolveRecord(server.env),
      headers: resolveRecord(server.headers),
    };
  }

  return {
    resolvedConfig: { mcpServers: resolvedServers },
    missingSecretKeys: [...missingKeys].sort(),
  };
}

export class RepoMcpConfigStore {
  constructor(private readonly db: D1Database) {}

  async get(owner: string, name: string): Promise<RepoMcpConfig | null> {
    const row = await this.db
      .prepare("SELECT mcp_servers FROM repo_mcp_config WHERE repo_owner = ? AND repo_name = ?")
      .bind(owner.toLowerCase(), name.toLowerCase())
      .first<RepoMcpConfigRow>();

    if (!row) return null;
    return parseConfig(row.mcp_servers);
  }

  async upsert(owner: string, name: string, config: RepoMcpConfig): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO repo_mcp_config (repo_owner, repo_name, mcp_servers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
           mcp_servers = excluded.mcp_servers,
           updated_at = excluded.updated_at`
      )
      .bind(owner.toLowerCase(), name.toLowerCase(), JSON.stringify(config.mcpServers), now, now)
      .run();
  }

  async getBatch(
    repos: Array<{ owner: string; name: string }>
  ): Promise<Map<string, RepoMcpConfig | null>> {
    if (repos.length === 0) return new Map();

    const map = new Map<string, RepoMcpConfig | null>();
    for (let start = 0; start < repos.length; start += D1_BATCH_LIMIT) {
      const chunk = repos.slice(start, start + D1_BATCH_LIMIT);
      const statements = chunk.map((repo) =>
        this.db
          .prepare("SELECT mcp_servers FROM repo_mcp_config WHERE repo_owner = ? AND repo_name = ?")
          .bind(repo.owner.toLowerCase(), repo.name.toLowerCase())
      );
      const results = await this.db.batch<RepoMcpConfigRow>(statements);
      for (let i = 0; i < chunk.length; i++) {
        const key = `${chunk[i].owner.toLowerCase()}/${chunk[i].name.toLowerCase()}`;
        const rows = results[i]?.results;
        map.set(key, rows && rows.length > 0 ? parseConfig(rows[0].mcp_servers) : null);
      }
    }

    return map;
  }
}
