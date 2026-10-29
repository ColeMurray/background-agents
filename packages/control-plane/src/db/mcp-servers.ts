import {
  mcpServerCommandSchema,
  mcpServerCredentialMapSchema,
  mcpServerTypeSchema,
  type McpServerConfig,
  type McpServerMetadata,
  type ValidatedCreateMcpServerInput,
  type ValidatedUpdateMcpServerInput,
} from "@open-inspect/shared/types/integrations";
import { encryptToken, decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

const log = createLogger("db:mcp-servers");

export class McpServerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerValidationError";
  }
}

export class McpServerConflictError extends Error {}

/** An update must retain stored credentials that cannot be decrypted. */
export class McpServerCredentialsUnreadableError extends Error {}

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

interface McpServerRow {
  id: string;
  revision: number;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [raw];
  }
  return mcpServerCommandSchema.parse(parsed);
}

function safeJsonParseEnv(raw: string, serverId: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = mcpServerCredentialMapSchema.safeParse(parsed);
  if (result.success) return result.data;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const credentials: Record<string, string> = {};
  const rejectedKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") credentials[key] = value;
    else rejectedKeys.push(key);
  }
  if (rejectedKeys.length > 0) {
    log.warn("MCP server env entries rejected", {
      event: "mcp_server.env_entries_rejected",
      server_id: serverId,
      rejected_keys: rejectedKeys,
    });
  }
  return credentials;
}

function rowToConfig(row: McpServerRow, payload: Record<string, string>): McpServerConfig {
  const type = mcpServerTypeSchema.parse(row.type);
  const envOrHeaders: Pick<McpServerConfig, "env" | "headers"> =
    type === "remote" ? { headers: payload } : { env: payload };
  return {
    id: row.id,
    name: row.name,
    type,
    command: type === "local" ? safeJsonParseCommand(row.command) : undefined,
    url: type === "remote" ? (row.url ?? undefined) : undefined,
    ...envOrHeaders,
    repoScopes: parseRepoScopes(row.repo_scope),
    enabled: row.enabled === 1,
  };
}

/**
 * Credentials to store when an update names the ones to keep. Kept names retain
 * their stored values and spelling, sent values replace stored ones, and stored
 * names neither kept nor sent are dropped. Header names compare
 * case-insensitively; env var names are exact.
 */
function mergeKeptCredentials(
  type: McpServerConfig["type"],
  stored: Record<string, string>,
  incoming: Record<string, string>,
  keep: string[]
): Record<string, string> {
  const nameOf = (key: string) => (type === "remote" ? key.toLowerCase() : key);
  const kept = new Set(keep.map(nameOf));
  const sent = new Set(Object.keys(incoming).map(nameOf));
  const retained = Object.entries(stored).filter(
    ([key]) => kept.has(nameOf(key)) && !sent.has(nameOf(key))
  );
  return { ...Object.fromEntries(retained), ...incoming };
}

function rowToMetadata(row: McpServerRow, credentialKeys?: string[]): McpServerMetadata {
  const type = mcpServerTypeSchema.parse(row.type);
  const hasCredentials = row.env !== "" && row.env !== "{}" && row.env !== "null";
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    type,
    command: type === "local" ? safeJsonParseCommand(row.command) : undefined,
    url: type === "remote" ? (row.url ?? undefined) : undefined,
    hasEnv: type === "local" && hasCredentials,
    hasHeaders: type === "remote" && hasCredentials,
    ...(credentialKeys ? { credentialKeys } : {}),
    repoScopes: parseRepoScopes(row.repo_scope),
    enabled: row.enabled === 1,
  };
}

/** How much a metadata read reveals about each server's stored credentials. */
export interface McpServerMetadataOptions {
  /**
   * Name the stored credentials (`credentialKeys`). This decrypts every row
   * read, so pass it only for callers holding `mcp_servers.manage`; without it,
   * reads stay decrypt-free.
   */
  includeCredentialKeys?: boolean;
}

export class McpServerStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  /** Empty dicts are stored as plaintext "{}" so rowToMetadata() can detect "no credentials". */
  private async encryptEnv(env: Record<string, string>): Promise<string> {
    const plain = JSON.stringify(env);
    if (Object.keys(env).length === 0) return plain;
    return encryptToken(plain, this.encryptionKey);
  }

  /** Stored credentials, or null when the value is neither decryptable nor pre-encryption plaintext. */
  private async readEnv(raw: string, rowId: string): Promise<Record<string, string> | null> {
    // The write side stores an empty credential map as plaintext "{}" (see
    // encryptEnv) — recognize the full credential-free sentinel set that
    // rowToMetadata classifies ("", "{}", "null") before attempting a decrypt
    // that is guaranteed to fail into the error path.
    if (!raw || raw === "{}" || raw === "null") return {};
    try {
      const plain = await decryptToken(raw, this.encryptionKey);
      return safeJsonParseEnv(plain, rowId);
    } catch {
      // Decryption failed — try plaintext fallback (pre-encryption row)
      const plaintext = safeJsonParseEnv(raw, rowId);
      if (Object.keys(plaintext).length > 0) {
        log.warn("MCP server env decryption failed — treating as pre-encryption plaintext row", {
          event: "mcp_server.env_decrypt_fallback",
        });
        return plaintext;
      }
      log.error("MCP server env decryption failed and raw value is not plaintext JSON", {
        event: "mcp_server.env_decrypt_error",
      });
      return null;
    }
  }

  /** Best-effort read for sessions and metadata: unreadable credentials read as none. */
  private async decryptEnv(raw: string, rowId: string): Promise<Record<string, string>> {
    return (await this.readEnv(raw, rowId)) ?? {};
  }

  private async decryptRow(row: McpServerRow): Promise<McpServerConfig> {
    const env = await this.decryptEnv(row.env, row.id);
    return rowToConfig(row, env);
  }

  /**
   * Credential names come from decrypting the row, so a pre-encryption or
   * undecryptable row logs `mcp_server.env_decrypt_*` on each such read. Only
   * the names leave this method; the values are discarded.
   */
  private async toMetadata(
    row: McpServerRow,
    options: McpServerMetadataOptions
  ): Promise<McpServerMetadata> {
    if (!options.includeCredentialKeys) return rowToMetadata(row);
    return rowToMetadata(row, Object.keys(await this.decryptEnv(row.env, row.id)));
  }

  async list(
    repoScope?: string,
    options: McpServerMetadataOptions = {}
  ): Promise<McpServerMetadata[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM mcp_servers ORDER BY name")
      .all<McpServerRow>();
    const normalized = repoScope?.toLowerCase();
    const rows =
      normalized === undefined
        ? results
        : results.filter((row) => {
            const scopes = parseRepoScopes(row.repo_scope);
            return !scopes || scopes.some((s) => s.toLowerCase() === normalized);
          });
    return Promise.all(rows.map((row) => this.toMetadata(row, options)));
  }

  async get(id: string, options: McpServerMetadataOptions = {}): Promise<McpServerMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    return row ? this.toMetadata(row, options) : null;
  }

  async create(
    config: ValidatedCreateMcpServerInput,
    options: McpServerMetadataOptions = {}
  ): Promise<McpServerMetadata> {
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
          config.type === "local" ? JSON.stringify(config.command) : null,
          config.type === "remote" ? config.url : null,
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

    const created = await this.get(id, options);
    if (!created) {
      throw new Error(`MCP server '${id}' not found after insert — this should not happen`);
    }
    return created;
  }

  async update(
    id: string,
    patch: ValidatedUpdateMcpServerInput,
    expectedRevision?: number,
    options: McpServerMetadataOptions = {}
  ): Promise<McpServerMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    if (!row) return null;
    if (expectedRevision !== undefined && row.revision !== expectedRevision) {
      throw new McpServerConflictError("MCP server changed; reload and try again");
    }

    const rowType = mcpServerTypeSchema.parse(row.type);
    const mergedType = patch.type ?? rowType;
    if (mergedType === "local" && (patch.url !== undefined || patch.headers !== undefined)) {
      throw new McpServerValidationError("Local MCP servers do not support url or headers");
    }
    if (mergedType === "remote" && (patch.command !== undefined || patch.env !== undefined)) {
      throw new McpServerValidationError("Remote MCP servers do not support command or env");
    }

    const incoming = mergedType === "remote" ? patch.headers : patch.env;
    let revisionGuard = expectedRevision;
    let encryptedEnv: string;
    if (mergedType !== rowType) {
      // Env vars and headers are not interchangeable, so a type change drops the stored set.
      encryptedEnv = await this.encryptEnv(incoming ?? {});
    } else if (patch.keepCredentialKeys === undefined) {
      // Sent credentials replace the stored set; without any, it stays as stored.
      encryptedEnv = incoming === undefined ? row.env : await this.encryptEnv(incoming);
    } else {
      // Retaining values needs them decrypted. Fail closed rather than read an
      // unreadable set as empty and delete it.
      const stored = await this.readEnv(row.env, row.id);
      if (!stored) {
        throw new McpServerCredentialsUnreadableError(
          "Saved credentials for this MCP server cannot be decrypted; enter every credential again to replace them"
        );
      }
      encryptedEnv = await this.encryptEnv(
        mergeKeptCredentials(mergedType, stored, incoming ?? {}, patch.keepCredentialKeys)
      );
      // Kept values come from this read, so a concurrent write must not land in between.
      revisionGuard ??= row.revision;
    }

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
      const statement = this.db.prepare(
        `UPDATE mcp_servers SET name = ?, type = ?, command = ?, url = ?, env = ?, repo_scope = ?, enabled = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = COALESCE(?, revision)
         RETURNING *`
      );
      const updated = await statement
        .bind(
          patch.name ?? row.name,
          mergedType,
          mergedType === "local" && mergedCommand ? JSON.stringify(mergedCommand) : null,
          mergedType === "remote" ? (mergedUrl ?? null) : null,
          encryptedEnv,
          patch.repoScopes !== undefined
            ? patch.repoScopes?.length
              ? JSON.stringify(patch.repoScopes.map((r) => r.toLowerCase()))
              : null
            : row.repo_scope,
          patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
          now,
          id,
          revisionGuard ?? null
        )
        .first<McpServerRow>();
      if (!updated) {
        throw new McpServerConflictError("MCP server changed; reload and try again");
      }
      return await this.toMetadata(updated, options);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new McpServerValidationError(
          `An MCP server named '${patch.name ?? row.name}' already exists`
        );
      }
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").bind(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Servers applicable to a session's member repositories: unscoped servers
   * always apply; scoped servers apply when ANY member matches a scope.
   * Pass an empty list for repo-less sessions (unscoped servers only).
   */
  async getDecryptedForSession(
    repositories: Array<{ repoOwner: string; repoName: string }>
  ): Promise<McpServerConfig[]> {
    const repoFullNames = new Set(
      repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`.toLowerCase())
    );
    const { results } = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name")
      .all<McpServerRow>();

    const filtered = results.filter((row) => {
      const scopes = parseRepoScopes(row.repo_scope);
      if (!scopes) return true;
      return scopes.some((s) => repoFullNames.has(s.toLowerCase()));
    });

    return Promise.all(filtered.map((r) => this.decryptRow(r)));
  }
}
