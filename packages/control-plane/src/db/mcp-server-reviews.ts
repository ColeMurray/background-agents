import type { SqlDatabase } from "./sql-database";

/**
 * One tool a server offers, as it was reviewed.
 *
 * The effect is the reviewer's classification. A tool classified as a
 * mutation is recorded so the decision is auditable, but it can never reach a
 * connection snapshot: the snapshot only accepts reads.
 */
export interface McpToolReview {
  stableToolId: string;
  toolName: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  inputSchemaSha256: string;
  outputSchema?: unknown;
  outputSchemaSha256?: string;
  effect: "external_read" | "external_mutation";
  reviewedAt: number;
}

export interface McpServerReview {
  serverId: string;
  serverRevision: number;
  reviewedByUserId: string;
  reviewedAt: number;
  tools: McpToolReview[];
}

export class McpReviewValidationError extends Error {}

interface ReviewRow {
  stable_tool_id: string;
  server_id: string;
  server_revision: number;
  tool_name: string;
  title: string | null;
  description: string | null;
  input_schema_json: string;
  input_schema_sha256: string;
  output_schema_json: string | null;
  output_schema_sha256: string | null;
  effect: "external_read" | "external_mutation";
  reviewed_by_user_id: string;
  reviewed_at: number;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The reviewed catalog of a server revision.
 *
 * The review belongs to the workspace, and only an account that holds
 * `mcp_servers.manage` may write it. It is not delegable to a personal
 * connection: a connection stages an immutable, hash-pinned copy of the
 * reviewed reads, so a later review cannot widen a connection that already
 * exists.
 */
export class McpServerReviewStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Replace the review of one server revision.
   *
   * The whole revision is replaced, so a tool the reviewer removed cannot
   * survive in the review.
   */
  async review(input: {
    reviewedByUserId: string;
    serverId: string;
    serverRevision: number;
    tools: readonly McpToolReview[];
  }): Promise<McpServerReview> {
    const server = await this.db
      .prepare("SELECT revision FROM mcp_servers WHERE id = ?")
      .bind(input.serverId)
      .first<{ revision: number }>();
    if (!server) throw new McpReviewValidationError("MCP server not found");
    if (server.revision !== input.serverRevision) {
      throw new McpReviewValidationError(
        "The MCP server changed; review the current catalog again"
      );
    }

    const reviewedAt = Date.now();
    await this.db.batch([
      this.db
        .prepare("DELETE FROM mcp_reviewed_tools WHERE server_id = ? AND server_revision = ?")
        .bind(input.serverId, input.serverRevision),
      ...input.tools.map((tool) =>
        this.db
          .prepare(
            `INSERT INTO mcp_reviewed_tools
               (stable_tool_id, server_id, server_revision, tool_name, title, description,
                input_schema_json, input_schema_sha256, output_schema_json, output_schema_sha256,
                effect, reviewed_by_user_id, reviewed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            tool.stableToolId,
            input.serverId,
            input.serverRevision,
            tool.toolName,
            tool.title,
            tool.description,
            JSON.stringify(tool.inputSchema),
            tool.inputSchemaSha256,
            tool.outputSchema === undefined ? null : JSON.stringify(tool.outputSchema),
            tool.outputSchemaSha256 ?? null,
            tool.effect,
            input.reviewedByUserId,
            reviewedAt
          )
      ),
    ]);
    return {
      serverId: input.serverId,
      serverRevision: input.serverRevision,
      reviewedByUserId: input.reviewedByUserId,
      reviewedAt,
      tools: [...input.tools],
    };
  }

  /** The review of one server revision. */
  async get(serverId: string, serverRevision: number): Promise<McpServerReview | null> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM mcp_reviewed_tools
         WHERE server_id = ? AND server_revision = ?
         ORDER BY stable_tool_id`
      )
      .bind(serverId, serverRevision)
      .all<ReviewRow>();
    const list = rows.results ?? [];
    if (list.length === 0) return null;
    return {
      serverId,
      serverRevision,
      reviewedByUserId: list[0]!.reviewed_by_user_id,
      reviewedAt: list[0]!.reviewed_at,
      tools: await Promise.all(list.map((row) => toReview(row))),
    };
  }
}

async function toReview(row: ReviewRow): Promise<McpToolReview> {
  let inputSchema: unknown;
  let outputSchema: unknown;
  try {
    inputSchema = JSON.parse(row.input_schema_json);
    outputSchema = row.output_schema_json ? JSON.parse(row.output_schema_json) : undefined;
  } catch {
    throw new McpReviewValidationError("A reviewed MCP tool has an invalid schema");
  }
  return {
    stableToolId: row.stable_tool_id,
    toolName: row.tool_name,
    title: row.title,
    description: row.description,
    inputSchema,
    inputSchemaSha256: row.input_schema_sha256,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(row.output_schema_sha256 ? { outputSchemaSha256: row.output_schema_sha256 } : {}),
    effect: row.effect,
    reviewedAt: row.reviewed_at,
  };
}

/** Build the stable tool identity and schema hashes for one reviewed tool. */
export async function buildMcpToolReview(input: {
  toolName: string;
  title?: string | null;
  description?: string | null;
  inputSchema: unknown;
  outputSchema?: unknown;
  effect: "external_read" | "external_mutation";
}): Promise<McpToolReview> {
  const inputSchemaJson = JSON.stringify(input.inputSchema ?? {});
  const outputSchemaJson =
    input.outputSchema === undefined ? null : JSON.stringify(input.outputSchema);
  return {
    stableToolId: `mcptool_${(await sha256Hex(input.toolName)).slice(0, 32)}`,
    toolName: input.toolName,
    title: input.title ?? null,
    description: input.description ?? null,
    inputSchema: input.inputSchema ?? {},
    inputSchemaSha256: await sha256Hex(inputSchemaJson),
    ...(outputSchemaJson === null ? {} : { outputSchema: input.outputSchema }),
    ...(outputSchemaJson === null ? {} : { outputSchemaSha256: await sha256Hex(outputSchemaJson) }),
    effect: input.effect,
    reviewedAt: Date.now(),
  };
}
