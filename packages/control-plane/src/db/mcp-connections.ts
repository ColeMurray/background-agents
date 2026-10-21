import type {
  McpConnectionMetadata,
  McpConnectionStatus,
  McpReviewedReadOnlyTool,
} from "@open-inspect/shared/types/integrations";
import type { ToolEffectKind } from "@open-inspect/shared/pi-tool-effects";
import { generateId } from "../auth/crypto";
import { validateMcpRemoteUrl, McpRemoteUrlPolicyError } from "../mcp/remote-url-policy";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface ServerRow {
  id: string;
  revision: number;
  name: string;
  type: string;
  url: string | null;
  env: string;
  enabled: number;
}

interface ConnectionRow {
  id: string;
  owner_user_id: string;
  server_id: string;
  server_revision: number;
  server_name: string;
  endpoint_url: string;
  endpoint_host: string;
  catalog_snapshot_sha256: string;
  status: McpConnectionStatus;
  created_at: number;
  updated_at: number;
}

interface ToolRow {
  connection_id: string;
  stable_tool_id: string;
  tool_name: string;
  title: string | null;
  description: string | null;
  input_schema_json: string;
  input_schema_sha256: string;
  output_schema_json: string | null;
  output_schema_sha256: string | null;
  reviewed_at: number;
}

export class McpConnectionValidationError extends Error {}
export class McpConnectionConflictError extends Error {}
const MCP_READ_EFFECT = "external_read" satisfies ToolEffectKind;

/**
 * The transport states the broker may record.
 *
 * The owner's lifecycle states (`foundation_staged`, `revoking`) belong to the
 * saga. The transport states belong to the broker, because the broker is the
 * only component that observes them.
 */
export const MCP_TRANSPORT_STATUSES = [
  "transport_ready",
  "oauth_authorizing",
  "oauth_ready",
  "failed",
] as const;
export type McpTransportStatus = (typeof MCP_TRANSPORT_STATUSES)[number];

function hasStaticCredentials(raw: string): boolean {
  return raw !== "" && raw !== "{}" && raw !== "null";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function catalogSnapshotSha256(
  serverId: string,
  serverRevision: number,
  tools: readonly McpReviewedReadOnlyTool[]
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      serverId,
      serverRevision,
      tools: tools.map((tool) => ({
        stableToolId: tool.stableToolId,
        name: tool.name,
        title: tool.title ?? null,
        description: tool.description ?? null,
        inputSchemaSha256: tool.inputSchemaSha256,
        outputSchemaSha256: tool.outputSchemaSha256 ?? null,
      })),
    })
  );
}

async function toTool(row: ToolRow): Promise<McpReviewedReadOnlyTool> {
  let inputSchema: unknown;
  let outputSchema: unknown;
  try {
    inputSchema = JSON.parse(row.input_schema_json);
    outputSchema = row.output_schema_json ? JSON.parse(row.output_schema_json) : undefined;
  } catch {
    throw new McpConnectionValidationError(
      `Reviewed MCP tool '${row.stable_tool_id}' has an invalid input schema`
    );
  }
  if ((await sha256Hex(row.input_schema_json)) !== row.input_schema_sha256) {
    throw new McpConnectionValidationError(
      `Reviewed MCP tool '${row.stable_tool_id}' input schema hash does not match`
    );
  }
  if (
    row.output_schema_json &&
    (!row.output_schema_sha256 ||
      (await sha256Hex(row.output_schema_json)) !== row.output_schema_sha256)
  ) {
    throw new McpConnectionValidationError(
      `Reviewed MCP tool '${row.stable_tool_id}' output schema hash does not match`
    );
  }
  return {
    stableToolId: row.stable_tool_id,
    name: row.tool_name,
    ...(row.title ? { title: row.title } : {}),
    ...(row.description ? { description: row.description } : {}),
    inputSchema,
    inputSchemaSha256: row.input_schema_sha256,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(row.output_schema_sha256 ? { outputSchemaSha256: row.output_schema_sha256 } : {}),
    reviewedAt: row.reviewed_at,
  };
}

function toMetadata(
  row: ConnectionRow,
  tools: readonly McpReviewedReadOnlyTool[]
): McpConnectionMetadata {
  return {
    id: row.id,
    serverId: row.server_id,
    serverRevision: row.server_revision,
    serverName: row.server_name,
    endpointUrl: row.endpoint_url,
    endpointHost: row.endpoint_host,
    catalogSnapshotSha256: row.catalog_snapshot_sha256,
    status: row.status,
    tools: [...tools],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class McpConnectionStore {
  constructor(private readonly db: SqlDatabase) {}

  async listOwned(ownerUserId: string): Promise<McpConnectionMetadata[]> {
    const connections = await this.db
      .prepare(
        `SELECT * FROM mcp_connections
         WHERE owner_user_id = ? ORDER BY lower(server_name), id`
      )
      .bind(ownerUserId)
      .all<ConnectionRow>();
    const rows = connections.results ?? [];
    if (rows.length === 0) return [];
    const tools = await this.db
      .prepare(
        `SELECT c.id AS connection_id, t.stable_tool_id, t.tool_name, t.title,
                t.description, t.input_schema_json, t.input_schema_sha256,
                t.output_schema_json, t.output_schema_sha256, t.reviewed_at
         FROM mcp_connections c
         JOIN mcp_connection_tool_snapshots t ON t.connection_id = c.id
         WHERE c.owner_user_id = ? AND t.effect = ?
         ORDER BY c.id, t.stable_tool_id`
      )
      .bind(ownerUserId, MCP_READ_EFFECT)
      .all<ToolRow>();
    const toolsByConnection = new Map<string, McpReviewedReadOnlyTool[]>();
    for (const tool of tools.results ?? []) {
      const catalog = toolsByConnection.get(tool.connection_id) ?? [];
      catalog.push(await toTool(tool));
      toolsByConnection.set(tool.connection_id, catalog);
    }
    const metadata: McpConnectionMetadata[] = [];
    for (const row of rows) {
      const catalog = toolsByConnection.get(row.id) ?? [];
      if (
        (await catalogSnapshotSha256(row.server_id, row.server_revision, catalog)) !==
        row.catalog_snapshot_sha256
      ) {
        throw new McpConnectionValidationError(
          `MCP connection '${row.id}' catalog snapshot hash does not match`
        );
      }
      metadata.push(toMetadata(row, catalog));
    }
    return metadata;
  }

  async getOwned(id: string, ownerUserId: string): Promise<McpConnectionMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_connections WHERE id = ? AND owner_user_id = ?")
      .bind(id, ownerUserId)
      .first<ConnectionRow>();
    if (!row) return null;
    if (row.status === "revoking") return toMetadata(row, []);
    const all = await this.listOwned(ownerUserId);
    return all.find((connection) => connection.id === id) ?? null;
  }

  /** Revocation authority read that remains available even when a catalog snapshot is corrupt. */
  async getOwnedForSaga(id: string, ownerUserId: string): Promise<McpConnectionMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_connections WHERE id = ? AND owner_user_id = ?")
      .bind(id, ownerUserId)
      .first<ConnectionRow>();
    return row ? toMetadata(row, []) : null;
  }

  async findOwnedByServer(
    ownerUserId: string,
    serverId: string
  ): Promise<McpConnectionMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_connections WHERE owner_user_id = ? AND server_id = ?")
      .bind(ownerUserId, serverId)
      .first<ConnectionRow>();
    if (!row) return null;
    if (row.status === "revoking") return toMetadata(row, []);
    return this.getOwned(row.id, ownerUserId);
  }

  async markRevoking(id: string, ownerUserId: string): Promise<McpConnectionMetadata | null> {
    const row = await this.db
      .prepare(
        `UPDATE mcp_connections SET status = 'revoking', updated_at = ?
         WHERE id = ? AND owner_user_id = ?
         RETURNING *`
      )
      .bind(Date.now(), id, ownerUserId)
      .first<ConnectionRow>();
    return row ? toMetadata(row, []) : null;
  }

  async deleteRevoking(id: string, ownerUserId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "DELETE FROM mcp_connections WHERE id = ? AND owner_user_id = ? AND status = 'revoking'"
      )
      .bind(id, ownerUserId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Record the transport state of one connection.
   *
   * The write is owner-scoped, so one owner can never record a state on
   * another owner's connection. It never overwrites a revocation in flight:
   * a late transport event cannot resurrect a connection the owner is
   * removing.
   */
  async setTransportStatus(
    id: string,
    ownerUserId: string,
    status: McpTransportStatus
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE mcp_connections SET status = ?, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND status <> 'revoking'`
      )
      .bind(status, Date.now(), id, ownerUserId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async create(ownerUserId: string, serverId: string): Promise<McpConnectionMetadata> {
    const server = await this.db
      .prepare("SELECT id, revision, name, type, url, env, enabled FROM mcp_servers WHERE id = ?")
      .bind(serverId)
      .first<ServerRow>();
    if (!server || server.enabled !== 1) {
      throw new McpConnectionValidationError("MCP server is not available");
    }
    if (server.type !== "remote" || !server.url) {
      throw new McpConnectionValidationError("Personal MCP connections require a remote server");
    }
    if (hasStaticCredentials(server.env)) {
      throw new McpConnectionValidationError(
        "Static MCP credential headers are not supported by personal connections"
      );
    }
    let endpoint: ReturnType<typeof validateMcpRemoteUrl>;
    try {
      endpoint = validateMcpRemoteUrl(server.url);
    } catch (error) {
      if (error instanceof McpRemoteUrlPolicyError) {
        throw new McpConnectionValidationError(error.message);
      }
      throw error;
    }

    const id = `mcpconn_${generateId()}`;
    const now = Date.now();
    const reviewed = await this.db
      .prepare(
        `SELECT '' AS connection_id, stable_tool_id, tool_name, title, description,
                input_schema_json, input_schema_sha256, output_schema_json,
                output_schema_sha256, reviewed_at
         FROM mcp_reviewed_tools
         WHERE server_id = ? AND server_revision = ? AND effect = ?
         ORDER BY stable_tool_id`
      )
      .bind(server.id, server.revision, MCP_READ_EFFECT)
      .all<ToolRow>();
    const reviewedTools: Array<{ row: ToolRow; tool: McpReviewedReadOnlyTool }> = [];
    for (const row of reviewed.results ?? []) reviewedTools.push({ row, tool: await toTool(row) });
    const catalogHash = await catalogSnapshotSha256(
      server.id,
      server.revision,
      reviewedTools.map(({ tool }) => tool)
    );
    const statements: SqlStatement[] = [
      this.db
        .prepare(
          `INSERT INTO mcp_connections
             (id, owner_user_id, server_id, server_revision, server_name, endpoint_url,
              endpoint_host, catalog_snapshot_sha256, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'foundation_staged', ?, ?)`
        )
        .bind(
          id,
          ownerUserId,
          server.id,
          server.revision,
          server.name,
          endpoint.endpointUrl,
          endpoint.endpointHost,
          catalogHash,
          now,
          now
        ),
      ...reviewedTools.map(({ row }) =>
        this.db
          .prepare(
            `INSERT INTO mcp_connection_tool_snapshots
               (connection_id, stable_tool_id, tool_name, title, description,
                input_schema_json, input_schema_sha256, output_schema_json,
                output_schema_sha256, effect, reviewed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            row.stable_tool_id,
            row.tool_name,
            row.title,
            row.description,
            row.input_schema_json,
            row.input_schema_sha256,
            row.output_schema_json,
            row.output_schema_sha256,
            MCP_READ_EFFECT,
            row.reviewed_at
          )
      ),
    ];
    try {
      await this.db.batch(statements);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new McpConnectionConflictError("This MCP server is already staged for your account");
      }
      throw error;
    }
    const connection = await this.getOwned(id, ownerUserId);
    if (!connection) throw new Error("MCP connection not found after insert");
    return connection;
  }
}
