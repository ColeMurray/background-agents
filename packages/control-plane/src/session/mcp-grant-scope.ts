/**
 * Re-evaluating an MCP grant against **current** authority.
 *
 * A grant is a decision made at one moment. The authority behind it — the
 * server's repository scope, whether the server is enabled, which tools the
 * server's review currently carries — can change after that moment, and a
 * change is an operator's revocation signal. So a grant is not a permission
 * that persists; it is an *input* to a decision that is taken again, every
 * time, from the database as it stands now.
 *
 * This module is that decision, in one place, so the grant path and the call
 * path cannot drift apart: the same function answers "may this session use
 * this connection?" at grant time and at call time.
 *
 * It is deliberately harness-neutral. It is about an MCP grant and the
 * session that holds it, not about any particular agent.
 */

import type {
  McpConnectionMetadata,
  McpServerMetadata,
} from "@open-inspect/shared/types/integrations";
import type { SqlDatabase } from "../db/sql-database";
import { validateMcpRemoteUrl } from "../mcp/remote-url-policy";

/** The repositories a session holds. */
export interface McpGrantRepositories {
  readonly repoOwner: string;
  readonly repoName: string;
}

export interface McpGrantScopeRequest {
  /** The connection the grant names. */
  readonly connectionId: string;
  /** The connection's owner. A grant is never used by anyone else. */
  readonly ownerUserId: string;
  /** The session's own repositories, read now. */
  readonly repositories: readonly McpGrantRepositories[];
}

export type McpGrantScopeDecision =
  | { readonly kind: "allowed"; readonly serverId: string; readonly serverRevision: number }
  | { readonly kind: "denied"; readonly reason: string };

export interface McpGrantScopeOptions {
  readonly db: SqlDatabase;
  readonly servers: { get(id: string): Promise<McpServerMetadata | null> };
  readonly connections: {
    getOwned(id: string, ownerUserId: string): Promise<McpConnectionMetadata | null>;
  };
  /**
   * The tools the server's **current** review carries.
   *
   * Read from the review rows for the server's current revision, so a tool
   * withdrawn from the review stops being callable even though a pin taken
   * earlier still names it.
   */
  readonly reviewedToolNames: (
    serverId: string,
    serverRevision: number
  ) => Promise<readonly string[]>;
}

/**
 * Whether this session may use this connection, right now.
 *
 * The rules are the ones the shared lane already obeys: the server must
 * exist, be enabled, and its repository scope must still cover one of the
 * session's repositories.
 */
export async function evaluateMcpGrantScope(
  options: McpGrantScopeOptions,
  request: McpGrantScopeRequest
): Promise<McpGrantScopeDecision> {
  const connection = await options.connections.getOwned(request.connectionId, request.ownerUserId);
  if (!connection) return { kind: "denied", reason: "MCP connection not found" };

  const server = await options.servers.get(connection.serverId);
  if (!server) return { kind: "denied", reason: "MCP server not found" };
  if (!server.enabled) {
    return { kind: "denied", reason: "This MCP server is not available to this session" };
  }
  if (connection.serverRevision !== server.revision || !server.url) {
    return { kind: "denied", reason: "This MCP connection no longer matches its reviewed server" };
  }
  try {
    const endpoint = validateMcpRemoteUrl(server.url);
    if (
      endpoint.endpointUrl !== connection.endpointUrl ||
      endpoint.endpointHost !== connection.endpointHost
    ) {
      return {
        kind: "denied",
        reason: "This MCP connection no longer matches its reviewed server",
      };
    }
  } catch {
    return { kind: "denied", reason: "This MCP connection no longer matches its reviewed server" };
  }

  const scopes = server.repoScopes;
  if (scopes && scopes.length > 0) {
    const owned = new Set(
      request.repositories.map((repository) =>
        `${repository.repoOwner}/${repository.repoName}`.toLowerCase()
      )
    );
    const allowed = scopes.some((scope) => owned.has(scope.toLowerCase()));
    if (!allowed) {
      return { kind: "denied", reason: "This MCP server is not available to this session" };
    }
  }

  return { kind: "allowed", serverId: server.id, serverRevision: server.revision };
}

/**
 * Whether this session may call this tool on this connection, right now.
 *
 * Two independent sets, and both must hold:
 *
 * - the **frozen** set the pin names — so widening the review never adds a
 *   tool to a grant that was made before it; and
 * - the server's **current** reviewed set — so narrowing the review does
 *   remove a tool from a grant that was made before it.
 */
export async function evaluateMcpGrantTool(
  options: McpGrantScopeOptions,
  request: McpGrantScopeRequest & {
    readonly toolName: string;
    /** The tools the pin froze when the grant was made. */
    readonly pinnedToolNames: readonly string[];
  }
): Promise<McpGrantScopeDecision> {
  const scope = await evaluateMcpGrantScope(options, request);
  if (scope.kind === "denied") return scope;

  if (!request.pinnedToolNames.includes(request.toolName)) {
    return { kind: "denied", reason: "This MCP tool is not part of the granted catalog" };
  }

  const current = await options.reviewedToolNames(scope.serverId, scope.serverRevision);
  if (!current.includes(request.toolName)) {
    return { kind: "denied", reason: "This MCP tool is not part of the reviewed catalog" };
  }

  return scope;
}

/**
 * The read-only tools a server's **current** review carries.
 *
 * The same read the shared lane uses, moved here so both lanes resolve the
 * catalogue the same way.
 */
export async function reviewedReadOnlyToolNames(
  db: SqlDatabase,
  serverId: string,
  serverRevision: number
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT tool_name FROM mcp_reviewed_tools
       WHERE server_id = ? AND server_revision = ? AND effect = 'external_read'
       ORDER BY tool_name`
    )
    .bind(serverId, serverRevision)
    .all<{ tool_name: string }>();
  return (rows.results ?? []).map((row) => row.tool_name);
}
