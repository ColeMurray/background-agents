import { DurableObject } from "cloudflare:workers";
import { MCPClientManager } from "agents/mcp/client";
import { requireMcpOAuthEncryptionKey } from "../env-validation";
import type { McpBrokerCall, McpBrokerCallResult } from "../mcp/broker-contract";
import {
  D1McpOAuthStorage,
  EncryptedMcpOAuthClientProvider,
} from "../mcp/encrypted-oauth-provider";
import { resolveMcpOAuthKeyring } from "../mcp/oauth-keyring";
import type { WorkerBindings } from "./platform";

type McpConnectionBindings = Pick<WorkerBindings, "DB" | "MCP_OAUTH_ENCRYPTION_KEY">;
const CONNECTION_ID_KEY = "open-inspect:mcp-connection-id";
const OWNER_USER_ID_KEY = "open-inspect:mcp-owner-user-id";
const DELETED_KEY = "open-inspect:mcp-deleted";
interface BrokerTombstone {
  connectionId: string;
  ownerUserId: string;
}

/**
 * Dormant per-connection MCP broker foundation.
 *
 * The manager deliberately is not installed on a Lifecycle yet: no persisted
 * registration is restored, no callback is accepted, and no network
 * connection or tool call can start in this slice. Installing the capability
 * is a separate live-transport canary gate. D1 remains authoritative; the
 * Agents `cf_agents_mcp_servers` table may later cache reconstructable
 * transport registrations only.
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
    enabled: false;
    connectionId: string;
    ownerUserId: string;
    transportCacheEntries: number;
    reason: string;
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
    // The transport is not installed in this slice, so a reviewed read reaches
    // the transport gate rather than the provider. The authorization above is
    // complete and is what the live transport will inherit.
    throw new Error("Live MCP transport is not enabled");
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
