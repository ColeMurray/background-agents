import type { McpServerConfig, McpServerMetadata } from "@open-inspect/shared";
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
  const envOrHeaders: Pick<McpServerConfig, "env" | "headers"> =
    row.type === "remote" ? { headers: payload } : { env: payload };
  return {
    id: row.id,
    name: row.name,
    type: row.type as "local" | "remote",
    command: safeJsonParseCommand(row.command),
    url: row.url ?? undefined,
    ...envOrHeaders,
    repoScopes: parseRepoScopes(row.repo_scope),
    enabled: row.enabled === 1,
  };
}

function rowToMetadata(row: McpServerRow): McpServerMetadata {
  const hasCredentials = row.env !== "" && row.env !== "{}" && row.env !== "null";
  return {
    id: row.id,
    name: row.name,
    type: row.type as "local" | "remote",
    command: safeJsonParseCommand(row.command),
    url: row.url ?? undefined,
    hasEnv: row.type === "local" && hasCredentials,
    hasHeaders: row.type === "remote" && hasCredentials,
    repoScopes: parseRepoScopes(row.repo_scope),
    enabled: row.enabled === 1,
  };
}

/** D1 doesn't expose structured error codes — string-match the SQLite message. */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes("unique constraint failed");
}

export class McpServerStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey?: string
  ) {}

  /** Empty dicts are stored as plaintext "{}" so rowToMetadata() can detect "no credentials". */
  private async encryptEnv(env: Record<string, string>): Promise<string> {
    const plain = JSON.stringify(env);
    if (!this.encryptionKey || Object.keys(env).length === 0) return plain;
    return encryptToken(plain, this.encryptionKey);
  }

  private async decryptEnv(raw: string): Promise<Record<string, string>> {
    if (!this.encryptionKey) return safeJsonParseEnv(raw);
    try {
      const plain = await decryptToken(raw, this.encryptionKey);
      return safeJsonParseEnv(plain);
    } catch {
      // Decryption failed — try plaintext fallback (pre-encryption row)
      const plaintext = safeJsonParseEnv(raw);
      if (Object.keys(plaintext).length > 0) {
        log.warn("MCP server env decryption failed — treating as pre-encryption plaintext row", {
          event: "mcp_server.env_decrypt_fallback",
        });
        return plaintext;
      }
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

  async list(repoScope?: string): Promise<McpServerMetadata[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM mcp_servers ORDER BY name")
      .all<McpServerRow>();
    const metadata = results.map(rowToMetadata);
    if (repoScope === undefined) return metadata;
    const normalized = repoScope.toLowerCase();
    return metadata.filter((c) => {
      if (!c.repoScopes) return true;
      return c.repoScopes.some((s) => s.toLowerCase() === normalized);
    });
  }

  async get(id: string): Promise<McpServerMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    return row ? rowToMetadata(row) : null;
  }

  async create(config: Omit<McpServerConfig, "id">): Promise<McpServerMetadata> {
    const id = generateId();
    const now = Date.now();

    if (config.type === "local" && (!config.command || config.command.length === 0)) {
      throw new McpServerValidationError("Local MCP servers require a command");
    }
    if (config.type === "remote" && !config.url) {
      throw new McpServerValidationError("remote MCP servers require a URL");
    }

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
  ): Promise<McpServerMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    if (!row) return null;

    const credentialsChanged =
      patch.env !== undefined || patch.headers !== undefined || patch.type !== undefined;

    let encryptedEnv: string;
    if (credentialsChanged) {
      const existing = await this.decryptRow(row);
      const mergedType = patch.type ?? existing.type;
      const mergedEnv = patch.env !== undefined ? patch.env : existing.env;
      const mergedHeaders = patch.headers !== undefined ? patch.headers : existing.headers;
      encryptedEnv = await this.encryptEnv(
        mergedType === "remote" ? (mergedHeaders ?? {}) : (mergedEnv ?? {})
      );
    } else {
      encryptedEnv = row.env;
    }

    const mergedType = patch.type ?? (row.type as "local" | "remote");
    const mergedCommand =
      patch.command !== undefined ? patch.command : safeJsonParseCommand(row.command);
    const mergedUrl = patch.url !== undefined ? patch.url : (row.url ?? undefined);

    if (mergedType === "local" && (!mergedCommand || mergedCommand.length === 0)) {
      throw new McpServerValidationError("Local MCP servers require a command");
    }
    if (mergedType === "remote" && !mergedUrl) {
      throw new McpServerValidationError("remote MCP servers require a URL");
    }

    const now = Date.now();

    try {
      await this.db
        .prepare(
          `UPDATE mcp_servers SET name = ?, type = ?, command = ?, url = ?, env = ?, repo_scope = ?, enabled = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(
          patch.name ?? row.name,
          mergedType,
          mergedCommand ? JSON.stringify(mergedCommand) : null,
          mergedUrl ?? null,
          encryptedEnv,
          patch.repoScopes !== undefined
            ? patch.repoScopes?.length
              ? JSON.stringify(patch.repoScopes.map((r) => r.toLowerCase()))
              : null
            : row.repo_scope,
          patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
          now,
          id
        )
        .run();
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new McpServerValidationError(
          `An MCP server named '${patch.name ?? row.name}' already exists`
        );
      }
      throw err;
    }

    const updated = await this.get(id);
    if (!updated) {
      throw new Error(`MCP server '${id}' not found after update — this should not happen`);
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").bind(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async getDecryptedForSession(repoOwner: string, repoName: string): Promise<McpServerConfig[]> {
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
