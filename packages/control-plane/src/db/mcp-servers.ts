import type { McpServerConfig } from "@open-inspect/shared";
import { encryptToken, decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";

const log = createLogger("db:mcp-servers");

export class McpServerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerValidationError";
  }
}

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

interface McpServerRow {
  id: string;
  name: string;
  type: string;
  command: string | null;
  url: string | null;
  env: string;
  repo_scope: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function parseRepoScopes(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [raw];
  } catch {
    return [raw];
  }
}

function safeJsonParseCommand(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return [raw];
  }
}

function safeJsonParseEnv(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rowToConfig(row: McpServerRow, payload: Record<string, string>): McpServerConfig {
  // The DB `env` column stores different things depending on server type:
  //   stdio  → process environment variables  → McpServerConfig.env
  //   remote → HTTP request headers           → McpServerConfig.headers
  const envOrHeaders: Pick<McpServerConfig, "env" | "headers"> =
    row.type === "remote" ? { headers: payload } : { env: payload };
  return {
    id: row.id,
    name: row.name,
    type: row.type as "stdio" | "remote",
    command: safeJsonParseCommand(row.command),
    url: row.url ?? undefined,
    ...envOrHeaders,
    repoScopes: parseRepoScopes(row.repo_scope),
    enabled: row.enabled === 1,
  };
}

/**
 * Check if an error message indicates a D1 UNIQUE constraint violation.
 *
 * NOTE: D1 does not expose structured error codes, so we string-match against the
 * SQLite error message. If Cloudflare ever changes the wording this check silently
 * becomes a no-op (constraint errors fall through as 503 instead of 400). Keep an
 * eye on this if D1 error shapes change in future Worker runtime versions.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes("unique constraint failed");
}

export class McpServerStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey?: string
  ) {}

  /** Encrypt env dict to a stored string. Falls back to plaintext if no key. */
  private async encryptEnv(env: Record<string, string>): Promise<string> {
    const plain = JSON.stringify(env);
    if (!this.encryptionKey) return plain;
    return encryptToken(plain, this.encryptionKey);
  }

  /**
   * Decrypt env string from storage.
   *
   * Three cases:
   * 1. No encryption key → treat as plaintext JSON (dev / unconfigured)
   * 2. Key present, decrypt succeeds → normal encrypted row
   * 3. Key present, decrypt fails → pre-encryption plaintext row (migration period).
   *    Falls back to JSON parse; logs a warning so ops can tell the difference from
   *    a key rotation mistake.
   *
   * NOTE: env values are returned in plaintext to callers. This is intentional —
   * they are required by the sandbox at runtime. Transport to Modal is over TLS.
   * Do NOT log the returned env object.
   */
  private async decryptEnv(raw: string): Promise<Record<string, string>> {
    if (!this.encryptionKey) return safeJsonParseEnv(raw);
    try {
      const plain = await decryptToken(raw, this.encryptionKey);
      return safeJsonParseEnv(plain);
    } catch {
      // Decryption failed — check if it looks like a pre-encryption plaintext row
      const plaintext = safeJsonParseEnv(raw);
      if (Object.keys(plaintext).length > 0) {
        log.warn("MCP server env decryption failed — treating as pre-encryption plaintext row", {
          event: "mcp_server.env_decrypt_fallback",
        });
        return plaintext;
      }
      // Empty JSON or ciphertext with wrong key — log a clear error, return empty
      log.error("MCP server env decryption failed and raw value is not plaintext JSON", {
        event: "mcp_server.env_decrypt_error",
      });
      return {};
    }
  }

  private async decryptRow(row: McpServerRow): Promise<McpServerConfig> {
    const env = await this.decryptEnv(row.env);
    return rowToConfig(row, env);
  }

  async list(repoScope?: string): Promise<McpServerConfig[]> {
    // NOTE: We load all rows then filter in-memory because repo_scope is stored as
    // JSON-serialised array, making SQL-level filtering awkward in D1/SQLite without
    // JSON_EACH. At expected scale (<100 MCP servers per deployment) this is fine.
    // TODO: push down to SQL once D1 supports JSON_EACH in WHERE clauses.
    const { results } = await this.db
      .prepare("SELECT * FROM mcp_servers ORDER BY name")
      .all<McpServerRow>();
    const configs = await Promise.all(results.map((r) => this.decryptRow(r)));
    if (repoScope === undefined) return configs;
    const normalized = repoScope.toLowerCase();
    return configs.filter((c) => {
      if (!c.repoScopes) return true;
      return c.repoScopes.some((s) => s.toLowerCase() === normalized);
    });
  }

  async get(id: string): Promise<McpServerConfig | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    return row ? this.decryptRow(row) : null;
  }

  async create(config: Omit<McpServerConfig, "id">): Promise<McpServerConfig> {
    const id = generateId();
    const now = Date.now();

    if (config.type === "stdio" && (!config.command || config.command.length === 0)) {
      throw new McpServerValidationError("stdio MCP servers require a command");
    }
    if (config.type === "remote" && !config.url) {
      throw new McpServerValidationError("remote MCP servers require a URL");
    }

    // For remote servers, the DB `env` column stores HTTP headers (McpServerConfig.headers).
    // For stdio servers, it stores process environment variables (McpServerConfig.env).
    const encryptedEnv = await this.encryptEnv(
      config.type === "remote" ? (config.headers ?? {}) : (config.env ?? {})
    );

    try {
      await this.db
        .prepare(
          `INSERT INTO mcp_servers (id, name, type, command, url, env, repo_scope, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          config.name,
          config.type,
          config.command ? JSON.stringify(config.command) : null,
          config.url ?? null,
          encryptedEnv,
          config.repoScopes?.length
            ? JSON.stringify(config.repoScopes.map((r) => r.toLowerCase()))
            : null,
          config.enabled ? 1 : 0,
          now,
          now
        )
        .run();
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new McpServerValidationError(`An MCP server named '${config.name}' already exists`);
      }
      throw err;
    }

    const created = await this.get(id);
    if (!created) {
      throw new Error(`MCP server '${id}' not found after insert — this should not happen`);
    }
    return created;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        McpServerConfig,
        "name" | "type" | "command" | "url" | "env" | "headers" | "repoScopes" | "enabled"
      >
    >
  ): Promise<McpServerConfig | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    // Explicit allowlist — id, created_at, updated_at cannot be overwritten
    const merged: Omit<McpServerConfig, "id"> = {
      name: patch.name ?? existing.name,
      type: patch.type ?? existing.type,
      command: patch.command !== undefined ? patch.command : existing.command,
      url: patch.url !== undefined ? patch.url : existing.url,
      env: patch.env !== undefined ? patch.env : existing.env,
      headers: patch.headers !== undefined ? patch.headers : existing.headers,
      repoScopes: patch.repoScopes !== undefined ? patch.repoScopes : existing.repoScopes,
      enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    };
    // Validate the merged result — catches cases where type is changed without
    // updating the corresponding command/url field (same rules as create()).
    if (merged.type === "stdio" && (!merged.command || merged.command.length === 0)) {
      throw new McpServerValidationError("stdio MCP servers require a command");
    }
    if (merged.type === "remote" && !merged.url) {
      throw new McpServerValidationError("remote MCP servers require a URL");
    }

    const now = Date.now();
    // For remote servers, the DB `env` column stores HTTP headers; for stdio, process env.
    const encryptedEnv = await this.encryptEnv(
      merged.type === "remote" ? (merged.headers ?? {}) : (merged.env ?? {})
    );

    try {
      await this.db
        .prepare(
          `UPDATE mcp_servers SET name = ?, type = ?, command = ?, url = ?, env = ?, repo_scope = ?, enabled = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(
          merged.name,
          merged.type,
          merged.command ? JSON.stringify(merged.command) : null,
          merged.url ?? null,
          encryptedEnv,
          merged.repoScopes?.length
            ? JSON.stringify(merged.repoScopes.map((r) => r.toLowerCase()))
            : null,
          merged.enabled ? 1 : 0,
          now,
          id
        )
        .run();
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new McpServerValidationError(`An MCP server named '${merged.name}' already exists`);
      }
      throw err;
    }

    // Build the return value from in-memory merged data — avoids a second read+decrypt cycle.
    // Note: unlike create() which round-trips through get(), this bypasses any DB-level
    // normalisation. In practice D1/SQLite does not transform the values we write, so the
    // result is equivalent. If that ever changes, swap this for `await this.get(id)`.
    return {
      id,
      ...merged,
      repoScopes: merged.repoScopes?.length ? merged.repoScopes.map((r) => r.toLowerCase()) : null,
    };
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").bind(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Get all enabled MCP servers applicable to a session (global + repo-specific).
   *
   * Returned env values are decrypted plaintext — required by the sandbox at runtime.
   * Do NOT log the returned McpServerConfig objects.
   */
  async getForSession(repoOwner: string, repoName: string): Promise<McpServerConfig[]> {
    const repoFullName = `${repoOwner}/${repoName}`.toLowerCase();
    const { results } = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name")
      .all<McpServerRow>();

    const filtered = results.filter((row) => {
      const scopes = parseRepoScopes(row.repo_scope);
      if (!scopes) return true;
      return scopes.some((s) => s.toLowerCase() === repoFullName);
    });

    return Promise.all(filtered.map((r) => this.decryptRow(r)));
  }
}
