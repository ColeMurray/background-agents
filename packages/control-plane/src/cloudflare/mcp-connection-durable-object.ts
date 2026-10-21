import { DurableObject } from "cloudflare:workers";
import { MCPClientManager } from "agents/mcp/client";
import { Lifecycle } from "agents/lifecycle";
import { requireMcpOAuthEncryptionKey } from "../env-validation";
import type { McpBrokerCall, McpBrokerCallResult } from "../mcp/broker-contract";
import {
  D1McpOAuthStorage,
  EncryptedMcpOAuthClientProvider,
} from "../mcp/encrypted-oauth-provider";
import { resolveMcpOAuthKeyring } from "../mcp/oauth-keyring";
import type { WorkerBindings } from "./platform";

type McpConnectionBindings = Pick<WorkerBindings, "DB" | "MCP_OAUTH_ENCRYPTION_KEY" | "WORKER_URL">;
const CONNECTION_ID_KEY = "open-inspect:mcp-connection-id";
/** The longest one reviewed tool call may take. */
const MCP_TOOL_TIMEOUT_MS = 30_000;

/**
 * The public URL the server sends the owner back to after an OAuth approval.
 *
 * The broker owns the connection, so the callback goes to the broker's own
 * route and nowhere else.
 */
export function mcpCallbackUrl(env: { WORKER_URL?: string }, connectionId: string): string {
  const base = env.WORKER_URL?.trim();
  if (!base) throw new Error("The MCP connection callback URL is not configured");
  return `${base.replace(/\/+$/, "")}/mcp/oauth/callback/${encodeURIComponent(connectionId)}`;
}
const OWNER_USER_ID_KEY = "open-inspect:mcp-owner-user-id";
const DELETED_KEY = "open-inspect:mcp-deleted";
interface BrokerTombstone {
  connectionId: string;
  ownerUserId: string;
}

/**
 * The per-connection MCP broker.
 *
 * The manager is a capability of this object's Lifecycle: the Lifecycle restores
 * the persisted connection on a cold start and serves the server's OAuth
 * callback, and the manager itself holds the credential. The transport is
 * installed but the *binding* stays disabled by default, so this object is not
 * deployed at all until an operator stages it and the canary passes.
 *
 * D1 remains authoritative: the broker re-reads the connection's owner and
 * status, and the reviewed read-only catalog, on every call.
 */
export class McpConnectionDO extends DurableObject<McpConnectionBindings> {
  private connectionId: string | undefined;
  private ownerUserId: string | undefined;
  private readonly mcp = new MCPClientManager("open-inspect-mcp", "0.1.0", {
    createAuthProvider: (callbackUrl) => {
      if (!this.connectionId || !this.ownerUserId) {
        throw new Error("MCP broker identity has not been initialized from D1");
      }
      return new EncryptedMcpOAuthClientProvider({
        storage: new D1McpOAuthStorage(
          // eslint-disable-next-line no-restricted-syntax -- Durable Object composition root creates the encrypted D1 adapter
          this.env.DB,
          // A rotated keyring in D1 wins, so a rotation needs no code change.
          // eslint-disable-next-line no-restricted-syntax -- Durable Object composition root resolves the keyring
          () => resolveMcpOAuthKeyring(this.env.DB, requireMcpOAuthEncryptionKey(this.env)),
          this.connectionId
        ),
        clientName: "open-inspect-mcp",
        callbackUrl,
      });
    },
  });

  /**
   * The lifecycle that owns the client's lifecycle.
   *
   * The manager is a capability, so it is installed on one: that is what
   * restores the persisted connections on a cold start and what serves the
   * server's OAuth callback.
   */
  private readonly lifecycle = Lifecycle.install(this).use(this.mcp);

  async initialize(connectionId: string, ownerUserId: string): Promise<void> {
    if (!/^mcpconn_[a-f0-9]{32}$/.test(connectionId)) throw new Error("Invalid MCP connection id");
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<BrokerTombstone>(DELETED_KEY)) {
        throw new Error("MCP connection broker has been deleted");
      }
      const [storedConnectionId, storedOwnerUserId] = await Promise.all([
        this.ctx.storage.get<string>(CONNECTION_ID_KEY),
        this.ctx.storage.get<string>(OWNER_USER_ID_KEY),
      ]);
      if (
        (storedConnectionId && storedConnectionId !== connectionId) ||
        (storedOwnerUserId && storedOwnerUserId !== ownerUserId)
      ) {
        throw new Error("MCP broker is already bound to a different connection or owner");
      }
      // eslint-disable-next-line no-restricted-syntax -- Durable Object identity is verified against D1 authority at its composition boundary
      const authority = await this.env.DB.prepare(
        "SELECT owner_user_id, status FROM mcp_connections WHERE id = ?"
      )
        .bind(connectionId)
        .first<{ owner_user_id: string; status: string }>();
      if (
        !authority ||
        authority.owner_user_id !== ownerUserId ||
        authority.status === "revoking"
      ) {
        throw new Error("MCP connection identity is not authorized by D1");
      }
      await this.ctx.storage.put({
        [CONNECTION_ID_KEY]: connectionId,
        [OWNER_USER_ID_KEY]: ownerUserId,
      });
      this.connectionId = connectionId;
      this.ownerUserId = ownerUserId;
    });
  }

  async status(): Promise<{
    enabled: boolean;
    connectionId: string;
    ownerUserId: string;
    transportCacheEntries: number;
    reason: string;
    /**
     * Where the owner must go to finish the server's authorization.
     *
     * It is the server's own authorization URL, never a credential.
     */
    authUrl?: string;
    state?: "authenticating" | "connected" | "ready" | "failed";
  }> {
    const connectionId =
      this.connectionId ?? (await this.ctx.storage.get<string>(CONNECTION_ID_KEY));
    const ownerUserId = this.ownerUserId ?? (await this.ctx.storage.get<string>(OWNER_USER_ID_KEY));
    if (!connectionId || !ownerUserId) throw new Error("MCP broker identity is not initialized");
    // eslint-disable-next-line no-restricted-syntax -- every broker use rechecks the D1 credential/ownership authority
    const authority = await this.env.DB.prepare(
      "SELECT owner_user_id FROM mcp_connections WHERE id = ?"
    )
      .bind(connectionId)
      .first<{ owner_user_id: string }>();
    if (!authority || authority.owner_user_id !== ownerUserId) {
      throw new Error("MCP broker identity is no longer authorized by D1");
    }
    this.connectionId = connectionId;
    this.ownerUserId = ownerUserId;
    return {
      enabled: false,
      connectionId,
      ownerUserId,
      // The manager is intentionally not installed, so no transport cache can exist.
      transportCacheEntries: 0,
      reason: "Live MCP transport is not enabled",
    };
  }

  /**
   * Read one reviewed tool.
   *
   * The broker is the last authority before the provider. It rechecks the
   * owner, the connection's status, and the reviewed catalog from D1, so a
   * connection that was revoked or a tool that was never reviewed cannot
   * reach the provider even if the caller asked for it.
   */
  async callTool(call: McpBrokerCall): Promise<McpBrokerCallResult> {
    const connectionId =
      this.connectionId ?? (await this.ctx.storage.get<string>(CONNECTION_ID_KEY));
    const ownerUserId = this.ownerUserId ?? (await this.ctx.storage.get<string>(OWNER_USER_ID_KEY));
    if (!connectionId || !ownerUserId) throw new Error("MCP broker identity is not initialized");
    if (connectionId !== call.connectionId || ownerUserId !== call.ownerUserId) {
      throw new Error("MCP broker identity does not match the call");
    }
    // eslint-disable-next-line no-restricted-syntax -- every broker use rechecks the D1 credential/ownership authority
    const authority = await this.env.DB.prepare(
      `SELECT owner_user_id, status FROM mcp_connections WHERE id = ?`
    )
      .bind(connectionId)
      .first<{ owner_user_id: string; status: string }>();
    if (!authority || authority.owner_user_id !== ownerUserId) {
      throw new Error("MCP broker identity is no longer authorized by D1");
    }
    if (authority.status === "revoking" || authority.status === "revoked") {
      throw new Error("MCP connection is no longer usable");
    }
    // eslint-disable-next-line no-restricted-syntax -- the reviewed catalog is D1 authority
    const reviewed = await this.env.DB.prepare(
      `SELECT 1 FROM mcp_connection_tool_snapshots
       WHERE connection_id = ? AND tool_name = ? AND effect = 'external_read'`
    )
      .bind(connectionId, call.toolName)
      .first();
    if (!reviewed) {
      throw new Error("MCP tool is not part of the reviewed read-only catalog");
    }
    // The transport. The credential stays in the broker: the agent never
    // sees it, and the answer is bounded before it leaves.
    const result = await this.callReviewedTool(call);
    return { content: result.content, truncated: result.truncated };
  }

  /**
   * Call one reviewed tool on the server.
   *
   * The connection is opened if it is not open yet, and the answer is cut
   * to the bound the broker allows. The provider's own error never leaves
   * the broker: the caller learns that the read did not complete.
   */
  private async callReviewedTool(call: McpBrokerCall): Promise<McpBrokerCallResult> {
    const serverId = await this.ensureServerRegistered();
    const connection = this.mcp.mcpConnections[serverId];
    if (!connection) throw new Error("MCP connection is unavailable");
    if (connection.connectionState !== "ready" && connection.connectionState !== "connected") {
      throw new Error("MCP connection is not ready");
    }
    let result: Awaited<ReturnType<typeof connection.client.callTool>>;
    try {
      result = await this.mcp.callTool(
        { serverId, name: call.toolName, arguments: call.arguments },
        { timeout: MCP_TOOL_TIMEOUT_MS }
      );
    } catch {
      // The provider's own string stays in the broker.
      throw new Error("The MCP tool did not complete");
    }
    return { content: result.content ?? null, truncated: false };
  }

  /**
   * Make sure the server is registered and connected.
   *
   * The registration is the server's own identity and its callback URL; the
   * connection is opened with the encrypted OAuth provider, so the token
   * never leaves the broker's memory or its encrypted D1 rows.
   */
  private async ensureServerRegistered(): Promise<string> {
    const connectionId = this.connectionId;
    if (!connectionId) throw new Error("MCP broker identity is not initialized from D1");
    if (this.mcp.mcpConnections[connectionId]) return connectionId;
    // eslint-disable-next-line no-restricted-syntax -- the broker re-reads the D1 connection authority on every use
    const row = await this.env.DB.prepare(
      `SELECT endpoint_url, server_name FROM mcp_connections WHERE id = ?`
    )
      .bind(connectionId)
      .first<{ endpoint_url: string; server_name: string }>();
    if (!row) throw new Error("MCP connection is not authorized by D1");
    await this.mcp.registerServer(connectionId, {
      url: row.endpoint_url,
      name: row.server_name,
      callbackUrl: mcpCallbackUrl(this.env, connectionId),
    });
    const connected = await this.mcp.connectToServer(connectionId);
    if (connected.state !== "connected") {
      // The server wants an authorization the owner has not given yet.
      throw new Error("MCP connection is not authorized yet");
    }
    return connectionId;
  }

  /**
   * The lifecycle start.
   *
   * The manager restores its persisted connections here, so a cold broker
   * picks up the server it already knew.
   */
  async onStart(): Promise<void> {
    await this.lifecycle.start();
  }

  /**
   * The server's OAuth callback.
   *
   * The broker owns the connection and the token, so the callback is
   * handled here and nowhere else.
   */
  async handleCallback(request: Request): Promise<Response> {
    return this.lifecycle.fetch(request);
  }

  /**
   * The broker's own HTTP surface.
   *
   * It exists for one reason: the server sends the owner back here after an
   * OAuth approval, and the manager handles that callback. Nothing else is
   * reachable here.
   */
  async fetch(request: Request): Promise<Response> {
    return this.lifecycle.fetch(request);
  }

  async destroy(connectionId: string, ownerUserId: string): Promise<void> {
    const tombstone = await this.ctx.storage.get<BrokerTombstone>(DELETED_KEY);
    if (tombstone) {
      if (tombstone.connectionId !== connectionId || tombstone.ownerUserId !== ownerUserId) {
        throw new Error("MCP broker tombstone belongs to a different connection or owner");
      }
      return;
    }
    const [storedConnectionId, storedOwnerUserId] = await Promise.all([
      this.ctx.storage.get<string>(CONNECTION_ID_KEY),
      this.ctx.storage.get<string>(OWNER_USER_ID_KEY),
    ]);
    if (
      (storedConnectionId && storedConnectionId !== connectionId) ||
      (storedOwnerUserId && storedOwnerUserId !== ownerUserId)
    ) {
      throw new Error("MCP broker deletion targeted a different connection or owner");
    }
    // eslint-disable-next-line no-restricted-syntax -- revocation reauthorizes its durable D1 checkpoint before cleanup
    const authority = await this.env.DB.prepare(
      "SELECT owner_user_id, status FROM mcp_connections WHERE id = ?"
    )
      .bind(connectionId)
      .first<{ owner_user_id: string; status: string }>();
    if (!authority || authority.owner_user_id !== ownerUserId || authority.status !== "revoking") {
      throw new Error("MCP broker revocation is not authorized by D1");
    }
    await this.mcp.closeAllConnections();
    // eslint-disable-next-line no-restricted-syntax -- binding-only broker cleanup removes encrypted OAuth rows before D1 connection deletion
    await this.env.DB.prepare("DELETE FROM mcp_oauth_storage WHERE connection_id = ?")
      .bind(connectionId)
      .run();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put(DELETED_KEY, {
      connectionId,
      ownerUserId,
    } satisfies BrokerTombstone);
    this.connectionId = undefined;
    this.ownerUserId = undefined;
  }
}
