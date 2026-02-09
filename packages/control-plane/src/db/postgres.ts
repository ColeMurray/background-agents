/**
 * PostgreSQL database layer.
 *
 * Replaces Cloudflare D1 with a pg connection pool. Provides CRUD for:
 * - Session index (listing/filtering sessions)
 * - Repo metadata (custom descriptions, aliases, channels)
 * - Repo secrets (encrypted per-repo environment variables)
 */

import pg from "pg";
import { encryptToken, decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";
import type { RepoMetadata } from "@open-inspect/shared";

const { Pool } = pg;
type Pool = InstanceType<typeof pg.Pool>;

const log = createLogger("postgres");

// ==================== Connection Pool ====================

let _pool: Pool | null = null;

/**
 * Get or create the PostgreSQL connection pool.
 */
export function getPool(databaseUrl: string): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    _pool.on("error", (err) => {
      log.error("Unexpected pool error", { error: err });
    });
  }
  return _pool;
}

/**
 * Close the pool (for graceful shutdown).
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// ==================== Session Index ====================

export interface SessionEntry {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  model: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface ListSessionsOptions {
  status?: string;
  excludeStatus?: string;
  repoOwner?: string;
  repoName?: string;
  limit?: number;
  offset?: number;
}

export interface ListSessionsResult {
  sessions: SessionEntry[];
  total: number;
  hasMore: boolean;
}

interface SessionRow {
  id: string;
  title: string | null;
  repo_owner: string;
  repo_name: string;
  model: string;
  status: string;
  created_at: string; // bigint comes as string from pg
  updated_at: string;
}

function toSessionEntry(row: SessionRow): SessionEntry {
  return {
    id: row.id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    model: row.model,
    status: row.status,
    createdAt: parseInt(row.created_at, 10),
    updatedAt: parseInt(row.updated_at, 10),
  };
}

export class SessionIndexStore {
  constructor(private readonly pool: Pool) {}

  async create(session: SessionEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, title, repo_owner, repo_name, model, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        session.id,
        session.title,
        session.repoOwner.toLowerCase(),
        session.repoName.toLowerCase(),
        session.model,
        session.status,
        session.createdAt,
        session.updatedAt,
      ],
    );
  }

  async get(id: string): Promise<SessionEntry | null> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM sessions WHERE id = $1",
      [id],
    );
    return result.rows[0] ? toSessionEntry(result.rows[0]) : null;
  }

  async list(options: ListSessionsOptions = {}): Promise<ListSessionsResult> {
    const { status, excludeStatus, repoOwner, repoName, limit = 50, offset = 0 } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }

    if (excludeStatus) {
      conditions.push(`status != $${paramIdx++}`);
      params.push(excludeStatus);
    }

    if (repoOwner) {
      conditions.push(`repo_owner = $${paramIdx++}`);
      params.push(repoOwner.toLowerCase());
    }

    if (repoName) {
      conditions.push(`repo_name = $${paramIdx++}`);
      params.push(repoName.toLowerCase());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM sessions ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

    // Get paginated results
    const dataResult = await this.pool.query<SessionRow>(
      `SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );

    const sessions = dataResult.rows.map(toSessionEntry);

    return {
      sessions,
      total,
      hasMore: offset + sessions.length < total,
    };
  }

  async updateStatus(id: string, status: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE sessions SET status = $1, updated_at = $2 WHERE id = $3",
      [status, Date.now(), id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM sessions WHERE id = $1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

// ==================== Repo Metadata ====================

interface RepoMetadataRow {
  repo_owner: string;
  repo_name: string;
  description: string | null;
  aliases: string | null;
  channel_associations: string | null;
  keywords: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toRepoMetadata(row: RepoMetadataRow): RepoMetadata {
  const metadata: RepoMetadata = {};
  if (row.description != null) metadata.description = row.description;
  const aliases = parseJsonArray(row.aliases);
  if (aliases) metadata.aliases = aliases;
  const channelAssociations = parseJsonArray(row.channel_associations);
  if (channelAssociations) metadata.channelAssociations = channelAssociations;
  const keywords = parseJsonArray(row.keywords);
  if (keywords) metadata.keywords = keywords;
  return metadata;
}

export class RepoMetadataStore {
  constructor(private readonly pool: Pool) {}

  async get(owner: string, name: string): Promise<RepoMetadata | null> {
    const result = await this.pool.query<RepoMetadataRow>(
      "SELECT * FROM repo_metadata WHERE repo_owner = $1 AND repo_name = $2",
      [owner.toLowerCase(), name.toLowerCase()],
    );
    return result.rows[0] ? toRepoMetadata(result.rows[0]) : null;
  }

  async upsert(owner: string, name: string, metadata: RepoMetadata): Promise<void> {
    const now = Date.now();
    const normalizedOwner = owner.toLowerCase();
    const normalizedName = name.toLowerCase();

    await this.pool.query(
      `INSERT INTO repo_metadata (repo_owner, repo_name, description, aliases, channel_associations, keywords, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (repo_owner, repo_name) DO UPDATE SET
         description = EXCLUDED.description,
         aliases = EXCLUDED.aliases,
         channel_associations = EXCLUDED.channel_associations,
         keywords = EXCLUDED.keywords,
         updated_at = EXCLUDED.updated_at`,
      [
        normalizedOwner,
        normalizedName,
        metadata.description ?? null,
        metadata.aliases ? JSON.stringify(metadata.aliases) : null,
        metadata.channelAssociations ? JSON.stringify(metadata.channelAssociations) : null,
        metadata.keywords ? JSON.stringify(metadata.keywords) : null,
        now,
        now,
      ],
    );
  }

  async getBatch(
    repos: Array<{ owner: string; name: string }>,
  ): Promise<Map<string, RepoMetadata>> {
    if (repos.length === 0) return new Map();

    const map = new Map<string, RepoMetadata>();

    // Build a single query with ANY/array for efficiency
    const owners = repos.map((r) => r.owner.toLowerCase());
    const names = repos.map((r) => r.name.toLowerCase());

    // Use a CTE to pair owners with names for exact match
    const placeholders = repos
      .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
      .join(", ");
    const params = repos.flatMap((r) => [r.owner.toLowerCase(), r.name.toLowerCase()]);

    const result = await this.pool.query<RepoMetadataRow>(
      `SELECT rm.* FROM repo_metadata rm
       INNER JOIN (VALUES ${placeholders}) AS v(o, n) ON rm.repo_owner = v.o AND rm.repo_name = v.n`,
      params,
    );

    for (const row of result.rows) {
      const key = `${row.repo_owner}/${row.repo_name}`;
      map.set(key, toRepoMetadata(row));
    }

    return map;
  }
}

// ==================== Repo Secrets ====================

const VALID_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_SIZE = 16384;
const MAX_TOTAL_VALUE_SIZE = 65536;
const MAX_SECRETS_PER_REPO = 50;

const RESERVED_KEYS = new Set([
  "PYTHONUNBUFFERED",
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "SANDBOX_AUTH_TOKEN",
  "REPO_OWNER",
  "REPO_NAME",
  "GITHUB_APP_TOKEN",
  "SESSION_CONFIG",
  "RESTORED_FROM_SNAPSHOT",
  "OPENCODE_CONFIG_CONTENT",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "LANG",
]);

export class RepoSecretsValidationError extends Error {}

export interface SecretMetadata {
  key: string;
  createdAt: number;
  updatedAt: number;
}

export class RepoSecretsStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: string,
  ) {}

  normalizeKey(key: string): string {
    return key.toUpperCase();
  }

  validateKey(key: string): void {
    if (!key || key.length > MAX_KEY_LENGTH)
      throw new RepoSecretsValidationError("Key too long or empty");
    if (!VALID_KEY_PATTERN.test(key))
      throw new RepoSecretsValidationError("Key must match [A-Za-z_][A-Za-z0-9_]*");
    if (RESERVED_KEYS.has(key.toUpperCase()))
      throw new RepoSecretsValidationError(`Key '${key}' is reserved`);
  }

  validateValue(value: string): void {
    if (typeof value !== "string") throw new RepoSecretsValidationError("Value must be a string");
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > MAX_VALUE_SIZE)
      throw new RepoSecretsValidationError(`Value exceeds ${MAX_VALUE_SIZE} bytes`);
  }

  async setSecrets(
    repoId: number,
    repoOwner: string,
    repoName: string,
    secrets: Record<string, string>,
  ): Promise<{ created: number; updated: number; keys: string[] }> {
    const owner = repoOwner.toLowerCase();
    const name = repoName.toLowerCase();
    const now = Date.now();

    const normalized: Record<string, string> = {};
    let totalValueBytes = 0;
    for (const [rawKey, value] of Object.entries(secrets)) {
      const key = this.normalizeKey(rawKey);
      this.validateKey(key);
      this.validateValue(value);
      totalValueBytes += new TextEncoder().encode(value).length;
      normalized[key] = value;
    }

    if (totalValueBytes > MAX_TOTAL_VALUE_SIZE) {
      throw new RepoSecretsValidationError(
        `Total secret size exceeds ${MAX_TOTAL_VALUE_SIZE} bytes`,
      );
    }

    // Check existing keys
    const existingResult = await this.pool.query<{ key: string }>(
      "SELECT key FROM repo_secrets WHERE repo_id = $1",
      [repoId],
    );
    const existingKeySet = new Set(existingResult.rows.map((r) => r.key));

    const incomingKeys = Object.keys(normalized);
    const netNew = incomingKeys.filter((k) => !existingKeySet.has(k)).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_REPO) {
      throw new RepoSecretsValidationError(
        `Repository would exceed ${MAX_SECRETS_PER_REPO} secrets limit ` +
          `(current: ${existingKeySet.size}, adding: ${netNew})`,
      );
    }

    let created = 0;
    let updated = 0;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const [key, value] of Object.entries(normalized)) {
        const encrypted = await encryptToken(value, this.encryptionKey);
        const isNew = !existingKeySet.has(key);
        if (isNew) created++;
        else updated++;

        await client.query(
          `INSERT INTO repo_secrets (repo_id, repo_owner, repo_name, key, encrypted_value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (repo_id, key) DO UPDATE SET
             repo_owner = EXCLUDED.repo_owner,
             repo_name = EXCLUDED.repo_name,
             encrypted_value = EXCLUDED.encrypted_value,
             updated_at = EXCLUDED.updated_at`,
          [repoId, owner, name, key, encrypted, now, now],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return { created, updated, keys: incomingKeys };
  }

  async listSecretKeys(repoId: number): Promise<SecretMetadata[]> {
    const result = await this.pool.query<{ key: string; created_at: string; updated_at: string }>(
      "SELECT key, created_at, updated_at FROM repo_secrets WHERE repo_id = $1 ORDER BY key",
      [repoId],
    );

    return result.rows.map((row) => ({
      key: row.key,
      createdAt: parseInt(row.created_at, 10),
      updatedAt: parseInt(row.updated_at, 10),
    }));
  }

  async getDecryptedSecrets(repoId: number): Promise<Record<string, string>> {
    const result = await this.pool.query<{ key: string; encrypted_value: string }>(
      "SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = $1",
      [repoId],
    );

    const secrets: Record<string, string> = {};
    for (const row of result.rows) {
      try {
        secrets[row.key] = await decryptToken(row.encrypted_value, this.encryptionKey);
      } catch (e) {
        log.error("Failed to decrypt secret", {
          repo_id: repoId,
          key: row.key,
          error: e instanceof Error ? e.message : String(e),
        });
        throw new Error(`Failed to decrypt secret '${row.key}'`);
      }
    }

    return secrets;
  }

  async deleteSecret(repoId: number, key: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM repo_secrets WHERE repo_id = $1 AND key = $2",
      [repoId, this.normalizeKey(key)],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
