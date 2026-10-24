import type { SqlDatabase } from "./sql-database";

export interface McpReadAuditInput {
  requestId: string;
  /** The account whose identity the provider saw. */
  actorUserId: string;
  sessionId: string;
  connectionId: string;
  toolName: string;
  /** Whether the call produced a result. */
  outcome: "applied" | "refused";
  reasonCode: string;
  occurredAt: number;
}

/**
 * The workspace audit record of one reviewed MCP read.
 *
 * It records who the provider saw, which session asked, and which reviewed
 * tool ran. It never records the arguments or the result, and it never
 * records a credential.
 */
export class McpReadAuditStore {
  constructor(private readonly db: SqlDatabase) {}

  async write(input: McpReadAuditInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO authorization_audit_events
           (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
            action, resource_type, resource_id, team_id, reason_code, operation_result, metadata_json)
         VALUES (?, ?, ?, 'user', ?, 'mcp_tool.read', 'mcp_connection', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        `mcp-read:${input.sessionId}:${input.connectionId}:${input.toolName}:${input.occurredAt}`,
        input.occurredAt,
        input.requestId,
        input.actorUserId,
        input.connectionId,
        null,
        input.reasonCode,
        input.outcome,
        JSON.stringify({ sessionId: input.sessionId, toolName: input.toolName })
      )
      .run();
  }
}
