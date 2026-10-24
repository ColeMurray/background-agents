import type { SqlDatabase } from "./sql-database";
import { generateId } from "../auth/crypto";

/**
 * A session's authorization to use one reviewed MCP connection.
 *
 * The grant is made by the connection owner and names one session. A
 * collaborator of that session does not inherit the owner's OAuth by default:
 * the grant is the explicit act that makes the connection available, and the
 * grant records the catalog snapshot it was made against.
 */
export interface McpSessionPin {
  id: string;
  sessionId: string;
  connectionId: string;
  ownerUserId: string;
  catalogSnapshotSha256: string;
  /** The reviewed read-only tool names this grant exposes. */
  toolNames: string[];
  status: "active" | "revoking" | "revoked";
  createdAt: number;
  updatedAt: number;
}

interface PinRow {
  id: string;
  session_id: string;
  connection_id: string;
  owner_user_id: string;
  catalog_snapshot_sha256: string;
  tool_names: string;
  status: McpSessionPin["status"];
  created_at: number;
  updated_at: number;
}

export class McpSessionPinValidationError extends Error {}
export class McpSessionPinConflictError extends Error {}

/**
 * The reviewed tool names a grant may carry.
 *
 * The schema cannot check the payload — the JSON functions are not portable —
 * so the store checks it in the one place that writes the column. The names
 * are identifiers, so anything else is refused rather than stored.
 */
const REVIEWED_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function assertReviewableToolNames(toolNames: readonly string[]): void {
  if (toolNames.length === 0) {
    throw new McpSessionPinValidationError("An MCP session grant needs at least one reviewed tool");
  }
  if (toolNames.some((name) => !REVIEWED_TOOL_NAME.test(name))) {
    throw new McpSessionPinValidationError("An MCP session grant has an invalid tool name");
  }
}

function toPin(row: PinRow): McpSessionPin {
  let toolNames: unknown;
  try {
    toolNames = JSON.parse(row.tool_names);
  } catch {
    throw new McpSessionPinValidationError("MCP session grant has an invalid tool list");
  }
  if (!Array.isArray(toolNames) || toolNames.some((name) => typeof name !== "string")) {
    throw new McpSessionPinValidationError("MCP session grant has an invalid tool list");
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    connectionId: row.connection_id,
    ownerUserId: row.owner_user_id,
    catalogSnapshotSha256: row.catalog_snapshot_sha256,
    toolNames: toolNames as string[],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class McpSessionPinStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Grant one connection to one session.
   *
   * Only the connection's owner may make this grant, and the grant records the
   * catalog snapshot so a later catalog change cannot widen what the session
   * may read.
   */
  async grant(input: {
    ownerUserId: string;
    connectionId: string;
    sessionId: string;
    catalogSnapshotSha256: string;
    toolNames: readonly string[];
  }): Promise<McpSessionPin> {
    const connection = await this.db
      .prepare("SELECT owner_user_id, catalog_snapshot_sha256 FROM mcp_connections WHERE id = ?")
      .bind(input.connectionId)
      .first<{ owner_user_id: string; catalog_snapshot_sha256: string }>();
    if (!connection) {
      throw new McpSessionPinValidationError("MCP connection not found");
    }
    if (connection.owner_user_id !== input.ownerUserId) {
      // A grant is the owner's own act. It is not delegable.
      throw new McpSessionPinValidationError(
        "Only the MCP connection owner may grant it to a session"
      );
    }
    if (connection.catalog_snapshot_sha256 !== input.catalogSnapshotSha256) {
      throw new McpSessionPinConflictError(
        "The MCP connection catalog changed; review it again before granting"
      );
    }
    assertReviewableToolNames(input.toolNames);
    const id = `mcppin_${generateId()}`;
    const now = Date.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO mcp_session_pins
             (id, session_id, connection_id, owner_user_id, catalog_snapshot_sha256,
              tool_names, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .bind(
          id,
          input.sessionId,
          input.connectionId,
          input.ownerUserId,
          input.catalogSnapshotSha256,
          JSON.stringify([...input.toolNames]),
          now,
          now
        )
        .run();
    } catch (error) {
      if (isUnique(error)) {
        throw new McpSessionPinConflictError(
          "This MCP connection is already granted to this session"
        );
      }
      throw error;
    }
    const created = await this.get(id);
    if (!created) throw new Error("MCP session grant not found after insert");
    return created;
  }

  async get(id: string): Promise<McpSessionPin | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_session_pins WHERE id = ?")
      .bind(id)
      .first<PinRow>();
    return row ? toPin(row) : null;
  }

  /** The active grants of one session. */
  async listForSession(sessionId: string): Promise<McpSessionPin[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM mcp_session_pins
         WHERE session_id = ? AND status = 'active'
         ORDER BY created_at, id`
      )
      .bind(sessionId)
      .all<PinRow>();
    return (rows.results ?? []).map((row) => toPin(row));
  }

  /** The active grants of one connection, across every session it was granted to. */
  async listForConnection(connectionId: string): Promise<McpSessionPin[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM mcp_session_pins
         WHERE connection_id = ? AND status = 'active'
         ORDER BY created_at, id`
      )
      .bind(connectionId)
      .all<PinRow>();
    return (rows.results ?? []).map((row) => toPin(row));
  }

  /**
   * Revoke one grant.
   *
   * The revocation is scoped to the owner, so one owner can never revoke
   * another owner's grant.
   */
  async revoke(id: string, ownerUserId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE mcp_session_pins SET status = 'revoked', updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND status = 'active'`
      )
      .bind(Date.now(), id, ownerUserId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Revoke every grant of a connection. Used when the connection is revoked. */
  async revokeAllForConnection(connectionId: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE mcp_session_pins SET status = 'revoked', updated_at = ?
         WHERE connection_id = ? AND status = 'active'`
      )
      .bind(Date.now(), connectionId)
      .run();
    return result.meta?.changes ?? 0;
  }
}

function isUnique(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}
